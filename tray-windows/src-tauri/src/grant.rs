//! The one elevated step in pairing, and the only one.
//!
//! The daemon runs as `NT SERVICE\NessieExecutor`, an account with no profile
//! and no rights anywhere a person keeps their work, so before it can read the
//! chosen workspace somebody with administrative rights has to say so. That is
//! what the UAC prompt during pairing is for, and it is worth saying plainly in
//! the dialog: the tray is granting a service account read access to one directory
//! the person just chose.
//!
//! The same elevated run asks the service to record the authenticated client's
//! active login owner's independently verified SID under its private root, even
//! when UAC uses another administrator. The control pipe admits Administrators and
//! recorded accounts, so this lets the person's ordinary, unelevated tray
//! start, stop and configure executors afterwards without prompting again.
//!
//! Both halves are Win32 through and through — an ACL, a token, a `runas`
//! relaunch — so they live behind `cfg(windows)` in [`imp`]; what the rest of
//! the tray needs to know about them is the switch below.

/// The command-line switch the elevated instance is relaunched with. It carries
/// a directory the person chose in a native picker and nothing else: no
/// challenge, no key, no executor id ever reaches a command line.
pub const GRANT_SWITCH: &str = "--grant-workspace";

#[cfg(windows)]
mod imp {
    use std::{os::windows::ffi::OsStrExt, path::Path};

    use windows_sys::Win32::Foundation::{CloseHandle, HLOCAL, LocalFree, ERROR_SUCCESS};
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
        NO_MULTIPLE_TRUSTEE, SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_NAME, TRUSTEE_IS_USER,
        TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_READ;
    use windows_sys::Win32::System::Threading::{WaitForSingleObject, INFINITE};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    use nessie_windows_common::SERVICE_ACCOUNT;

    use super::GRANT_SWITCH;

    /// The service copies the selected root into a private COW workspace. It
    /// never promotes from this standalone surface, so Windows grants only the
    /// read rights that operation needs — not write, delete, execute, or the
    /// right to re-grant.
    const WORKSPACE_READ: u32 = FILE_GENERIC_READ;

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Adds the service account to the workspace's existing DACL, inherited by
    /// everything under it. The current ACL is read and merged rather than
    /// replaced: this directory is the person's own work, and an installer that
    /// rewrites its permissions wholesale is how people lose access to their
    /// files.
    fn grant_service_account(path: &Path) -> Result<(), String> {
        let object = wide_path(path);
        let mut existing: *mut ACL = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let read = unsafe {
            GetNamedSecurityInfoW(
                object.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut existing,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        if read != ERROR_SUCCESS {
            return Err("Windows would not read the workspace's permissions.".to_owned());
        }
        let mut account = wide(SERVICE_ACCOUNT);
        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: WORKSPACE_READ,
            grfAccessMode: SET_ACCESS,
            grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_NAME,
                TrusteeType: TRUSTEE_IS_USER,
                ptstrName: account.as_mut_ptr(),
            },
        };
        let mut merged: *mut ACL = std::ptr::null_mut();
        let built = unsafe { SetEntriesInAclW(1, &entry, existing, &mut merged) };
        if built != ERROR_SUCCESS || merged.is_null() {
            unsafe { LocalFree(descriptor as HLOCAL) };
            return Err("Windows would not prepare the workspace's permissions.".to_owned());
        }
        let applied = unsafe {
            SetNamedSecurityInfoW(
                object.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                merged,
                std::ptr::null(),
            )
        };
        unsafe {
            LocalFree(merged as HLOCAL);
            LocalFree(descriptor as HLOCAL);
        }
        if applied == ERROR_SUCCESS {
            Ok(())
        } else {
            Err("Windows would not grant the Nessie Executor service access to that workspace."
                .to_owned())
        }
    }

    /// The elevated half: grant the workspace, then have the service record
    /// the actual active session owner's SID. The service state root is
    /// intentionally unavailable even to an elevated administrator, so a
    /// direct marker write would weaken it or fail; the pipe verifies the
    /// elevated administrator token before it accepts this request.
    pub fn grant_workspace(path: &Path) -> Result<(), String> {
        grant_service_account(path)?;
        crate::pipe_client::service_control(&serde_json::json!({ "command": "enrollControlClient" }))?;
        // The accept loop has already created its next listener by the time
        // enrollment writes the marker. This elevated request consumes that
        // stale-DACL instance, so the following ordinary tray request reaches
        // a listener built with the newly admitted account.
        crate::pipe_client::service_control(&serde_json::json!({ "command": "status" }))?;
        Ok(())
    }

    /// The unelevated half: relaunch this executable elevated, with the chosen
    /// workspace and nothing else, and wait for it. `ShellExecuteExW` is
    /// `ShellExecuteW` plus the process handle, which is what makes waiting
    /// possible — pairing must not start before the grant has actually landed.
    pub fn request_workspace_grant(workspace: &Path) -> Result<(), String> {
        let executable = std::env::current_exe()
            .map_err(|_| "Nessie Executor could not locate itself.".to_owned())?;
        let file = wide_path(&executable);
        let verb = wide("runas");
        let parameters = wide(&format!("{GRANT_SWITCH} \"{}\"", workspace.display()));
        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = parameters.as_ptr();
        info.nShow = SW_HIDE;
        if unsafe { ShellExecuteExW(&mut info) } == 0 || info.hProcess.is_null() {
            // The overwhelmingly common cause is the person declining the
            // prompt, and that is a decision, not a defect.
            return Err(
                "Granting the Nessie Executor service access to that workspace was cancelled."
                    .to_owned(),
            );
        }
        unsafe { WaitForSingleObject(info.hProcess, INFINITE) };
        let mut code = 0_u32;
        let read = unsafe {
            windows_sys::Win32::System::Threading::GetExitCodeProcess(info.hProcess, &mut code)
        };
        unsafe { CloseHandle(info.hProcess) };
        if read != 0 && code == 0 {
            Ok(())
        } else {
            Err("The Nessie Executor service was not granted access to that workspace.".to_owned())
        }
    }
}

#[cfg(windows)]
pub use imp::{grant_workspace, request_workspace_grant};

#[cfg(not(windows))]
const WINDOWS_ONLY: &str =
    "Granting a workspace to the Nessie Executor service is a Windows operation.";

#[cfg(not(windows))]
pub fn grant_workspace(path: &std::path::Path) -> Result<(), String> {
    let _ = path;
    Err(WINDOWS_ONLY.to_owned())
}

#[cfg(not(windows))]
pub fn request_workspace_grant(workspace: &std::path::Path) -> Result<(), String> {
    let _ = workspace;
    Err(WINDOWS_ONLY.to_owned())
}

#[cfg(test)]
mod tests {
    use super::GRANT_SWITCH;

    /// The switch is matched exactly by `main`, and the elevated instance is
    /// given the workspace as its one argument: a switch that took a value in
    /// `--switch=value` form would put a path a person chose through Windows'
    /// own command-line splitting a second time.
    #[test]
    fn the_grant_switch_is_a_bare_flag_followed_by_the_workspace() {
        assert_eq!(GRANT_SWITCH, "--grant-workspace");
        assert!(!GRANT_SWITCH.contains('='));
    }
}
