pub const GRANT_SWITCH: &str = "--grant-workspace";

pub const ENROLL_SWITCH: &str = "--enroll-service-account";

// A closed exit protocol. No diagnostics, paths or credentials pass through a
// writable result file. Unknown exits (including a crash) never mean success.
const FOLDER_READ: &str =
    "Windows could not read this folder's permissions. Choose a folder you can manage.";
const FOLDER_PREPARE: &str = "Windows could not prepare read access to this folder. Check its permissions or choose another folder.";
const FOLDER_APPLY: &str = "Windows could not grant read access to this folder. Check its permissions or choose another folder.";
const SERVICE_REFUSED: &str =
    "The service refused account setup. Check the Nessie Computer service and retry.";
const BAD_REPLY: &str =
    "The service returned an invalid account setup response. Update Nessie Computer and retry.";
const CHILD_ERRORS: &[&str] = &[
    FOLDER_READ,
    FOLDER_PREPARE,
    FOLDER_APPLY,
    crate::pipe_client::SERVICE_NOT_RUNNING,
    crate::pipe_client::NOT_ADMITTED,
    crate::pipe_client::NOT_TRUSTED,
    crate::pipe_client::BUSY,
    crate::pipe_client::UNREACHABLE,
    "An administrator must approve control access for this account.",
    "Windows could not verify the signed-in account approved for this connection.",
    "Nessie Computer could not record this account.",
    SERVICE_REFUSED,
    BAD_REPLY,
    "Windows could not verify the approving Nessie Computer app. Repair or update the installation.",
];

fn child_result(code: u32) -> Result<(), String> {
    if code == 0 {
        return Ok(());
    }
    Err(code
        .checked_sub(20)
        .and_then(|i| CHILD_ERRORS.get(i as usize))
        .copied()
        .unwrap_or(
            "The administrator helper exited unexpectedly. Restart Nessie Computer and try again.",
        )
        .into())
}

#[cfg(windows)]
fn launch_failure(error: u32) -> &'static str {
    if error == windows_sys::Win32::Foundation::ERROR_CANCELLED {
        "Windows approval was cancelled. Try again to reopen the prompt."
    } else {
        "Windows could not open the administrator prompt. Check with your administrator and try again."
    }
}

fn child_exit(message: &str) -> i32 {
    CHILD_ERRORS
        .iter()
        .position(|known| *known == message)
        .map_or(1, |i| 20 + i as i32)
}

pub fn helper_exit(arguments: &[String]) -> Option<i32> {
    // The installed CLI uses the same ordinary tray entry point and receives
    // only a public diagnostic on its inherited stderr.
    let request = match arguments {
        [flag] if flag == "--request-service-access" => Some(ensure_service_access()),
        [flag, path] if flag == "--request-workspace-access" => {
            Some(request_workspace_grant(std::path::Path::new(path)))
        }
        _ => None,
    };
    if let Some(result) = request {
        return Some(match result {
            Ok(()) => 0,
            Err(reason) => {
                eprintln!("{reason}");
                1
            }
        });
    }
    let result = match arguments {
        [switch, path] if switch == GRANT_SWITCH => {
            imp::grant_service_account(std::path::Path::new(path)).and_then(|()| enroll())
        }
        [switch, path] if switch == "--grant-folder-read" => {
            imp::grant_service_account(std::path::Path::new(path))
        }
        [switch] if switch == ENROLL_SWITCH => enroll(),
        _ => return None,
    };
    Some(result.err().map_or(0, |reason| child_exit(&reason)))
}

fn status(command: &str) -> Result<(), String> {
    match crate::pipe_client::service_control(&serde_json::json!({"command": command}))? {
        crate::pipe_client::ServiceResponse::Status(_) => Ok(()),
        _ => Err(BAD_REPLY.into()),
    }
}

fn enroll() -> Result<(), String> {
    for command in ["enrollControlClient", "status"] {
        // The second call consumes the listener created before the enrollment marker.
        status(command).map_err(|reason| {
            if CHILD_ERRORS.contains(&reason.as_str()) {
                reason
            } else if reason == crate::pipe_client::UNREADABLE {
                BAD_REPLY.into()
            } else {
                SERVICE_REFUSED.into()
            }
        })?;
    }
    Ok(())
}

pub fn ensure_service_access() -> Result<(), String> {
    #[cfg(windows)]
    {
        // Only the person in the active desktop starts or resumes plan pairing.
        // An administrator approving UAC can be a different person.
        use nessie_windows_common::process::{interactive, Process};
        Process::open(std::process::id())
            .and_then(|p| interactive(&p))
            .map_err(|_| "Add the plan from the Windows account that is signed in.")?;
    }
    check_access(|| status("status"), || imp::request(ENROLL_SWITCH, None))
}

fn check_access(
    status: impl Fn() -> Result<(), String>,
    approve: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    match status() {
        Err(reason) if reason == crate::pipe_client::NOT_ADMITTED => {
            approve()?;
            status()
        }
        result => result,
    }
}

pub fn request_workspace_grant(workspace: &std::path::Path) -> Result<(), String> {
    imp::request("--grant-folder-read", Some(workspace))
}

#[cfg(windows)]
mod imp {
    use std::{os::windows::ffi::OsStrExt, path::Path};

    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS, HLOCAL};
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
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    use nessie_windows_common::SERVICE_ACCOUNT;

    use super::{FOLDER_APPLY, FOLDER_PREPARE, FOLDER_READ};

    /// The service copies the selected root into a private COW workspace. It
    /// never promotes from this standalone surface, so Windows grants only the
    /// read rights that operation needs — not write, delete, execute, or the
    /// right to re-grant.
    const WORKSPACE_READ: u32 = FILE_GENERIC_READ;

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Adds the service account to the workspace's existing DACL, inherited by
    /// everything under it. The current ACL is read and merged rather than
    /// replaced: this directory is the person's own work, and an installer that
    /// rewrites its permissions wholesale is how people lose access to their
    /// files.
    pub(super) fn grant_service_account(path: &Path) -> Result<(), String> {
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
            return Err(FOLDER_READ.to_owned());
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
            return Err(FOLDER_PREPARE.to_owned());
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
            Err(FOLDER_APPLY.to_owned())
        }
    }

    pub(super) fn request(switch: &str, workspace: Option<&Path>) -> Result<(), String> {
        let executable = std::env::current_exe()
            .map_err(|_| "Nessie Computer could not locate itself.".to_owned())?;
        let file = wide_path(&executable);
        let verb = wide("runas");
        // Windows command line parsing doubles trailing backslashes before a closing quote.
        let parameters = match workspace {
            Some(path) => {
                let path = path
                    .to_str()
                    .filter(|p| !p.contains('"'))
                    .ok_or("Invalid folder path.")?;
                let trailing = path.len() - path.trim_end_matches('\\').len();
                wide(&format!("{switch} \"{path}{}\"", "\\".repeat(trailing)))
            }
            None => wide(switch),
        };
        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = parameters.as_ptr();
        info.nShow = SW_HIDE;
        if unsafe { ShellExecuteExW(&mut info) } == 0 {
            let last_error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            return Err(super::launch_failure(last_error).into());
        }
        if info.hProcess.is_null() {
            return Err("Windows did not return the approval result.".into());
        }
        let mut code = 0;
        let completed = unsafe { WaitForSingleObject(info.hProcess, INFINITE) } == 0
            && unsafe {
                windows_sys::Win32::System::Threading::GetExitCodeProcess(info.hProcess, &mut code)
            } != 0;
        unsafe { CloseHandle(info.hProcess) };
        if !completed {
            return Err("Windows did not return the approval result.".into());
        }
        super::child_result(code)
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::Path;
    pub(super) fn request(_: &str, _: Option<&Path>) -> Result<(), String> {
        Err("Windows approval is unavailable.".into())
    }
    pub(super) fn grant_service_account(_: &Path) -> Result<(), String> {
        Err("Windows approval is unavailable.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::GRANT_SWITCH;

    #[test]
    fn child_failures_remain_distinct_after_elevation() {
        for reason in super::CHILD_ERRORS {
            assert_eq!(
                super::child_result(super::child_exit(reason) as u32),
                Err((*reason).into())
            );
        }
        assert_eq!(super::child_result(0), Ok(()));
        assert!(super::child_result(1).unwrap_err().contains("unexpectedly"));
    }

    #[test]
    fn only_denied_control_prompts_then_rechecks_as_the_ordinary_caller() {
        use crate::pipe_client::{NOT_ADMITTED, NOT_TRUSTED, SERVICE_NOT_RUNNING};
        for initial in [
            Ok(()),
            Err(NOT_TRUSTED.to_owned()),
            Err(SERVICE_NOT_RUNNING.to_owned()),
        ] {
            assert_eq!(
                super::check_access(|| initial.clone(), || panic!("unnecessary elevation")),
                initial
            );
        }
        let calls = std::cell::Cell::new(0);
        let status = || {
            let previous = calls.get();
            calls.set(previous + 1);
            if previous == 0 {
                Err(NOT_ADMITTED.into())
            } else {
                Ok(())
            }
        };
        assert_eq!(super::check_access(status, || Ok(())), Ok(()));
        assert_eq!(calls.get(), 2);
        assert_eq!(
            super::check_access(|| Err(NOT_ADMITTED.into()), || Err("declined".into())),
            Err("declined".into())
        );
    }

    #[test]
    #[cfg(windows)]
    fn only_windows_cancellation_is_reported_as_declined() {
        use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_CANCELLED};
        assert!(super::launch_failure(ERROR_CANCELLED).contains("cancelled"));
        assert!(!super::launch_failure(ERROR_ACCESS_DENIED).contains("cancelled"));
    }

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
