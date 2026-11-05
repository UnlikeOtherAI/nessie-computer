//! Credential custody is tied to the actual process token, never HOME.
use crate::protocol::NativeError;
use std::path::PathBuf;

#[cfg(windows)]
pub fn protected_root() -> Result<PathBuf, NativeError> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, IsWellKnownSid, TokenElevation, TokenSessionId, TokenUser,
        WinLocalServiceSid, WinLocalSystemSid, WinNetworkServiceSid, TOKEN_ELEVATION, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    #[link(name = "userenv")]
    extern "system" {
        fn GetUserProfileDirectoryW(token: HANDLE, path: *mut u16, size: *mut u32) -> i32;
    }
    let refused = || NativeError::new("EXECUTOR_PERSONAL_STATE_CONTEXT_REJECTED");
    let own =
        nessie_windows_common::process::Process::open(std::process::id()).map_err(|_| refused())?;
    nessie_windows_common::process::interactive(&own).map_err(|_| refused())?;
    let mut token: HANDLE = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(refused());
    }
    let result = (|| {
        let mut size = 0;
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 1 };
        if unsafe {
            GetTokenInformation(
                token,
                TokenElevation,
                (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut size,
            )
        } == 0
            || elevation.TokenIsElevated != 0
        {
            return Err(refused());
        }
        unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size) };
        let mut session = 0_u32;
        if unsafe {
            GetTokenInformation(
                token,
                TokenSessionId,
                (&mut session as *mut u32).cast(),
                std::mem::size_of::<u32>() as u32,
                &mut size,
            )
        } == 0
            || session == 0
        {
            return Err(refused());
        }
        // Query TokenUser's buffer size again after reading the session id.
        unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size) };
        let mut user = vec![0_u8; size as usize];
        if user.is_empty()
            || unsafe {
                GetTokenInformation(token, TokenUser, user.as_mut_ptr().cast(), size, &mut size)
            } == 0
        {
            return Err(refused());
        }
        let sid = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
        for kind in [WinLocalSystemSid, WinLocalServiceSid, WinNetworkServiceSid] {
            if unsafe { IsWellKnownSid(sid, kind) } != 0 {
                return Err(refused());
            }
        }
        size = 0;
        unsafe { GetUserProfileDirectoryW(token, std::ptr::null_mut(), &mut size) };
        if size == 0 || size > 32_768 {
            return Err(refused());
        }
        let mut path = vec![0_u16; size as usize];
        if unsafe { GetUserProfileDirectoryW(token, path.as_mut_ptr(), &mut size) } == 0 {
            return Err(refused());
        }
        let end = path
            .iter()
            .position(|value| *value == 0)
            .ok_or_else(refused)?;
        let profile = PathBuf::from(std::ffi::OsString::from_wide(&path[..end]));
        if !profile.is_absolute() {
            return Err(refused());
        }
        Ok(profile.join(".nessie").join("personal-inference"))
    })();
    unsafe { CloseHandle(token) };
    result
}

#[cfg(target_os = "macos")]
pub fn protected_root() -> Result<PathBuf, NativeError> {
    use std::{
        ffi::CStr,
        os::unix::fs::{FileTypeExt, MetadataExt},
    };
    let refused = || NativeError::new("EXECUTOR_PERSONAL_STATE_CONTEXT_REJECTED");
    let uid = unsafe { libc::getuid() };
    if uid == 0 || uid != unsafe { libc::geteuid() } {
        return Err(refused());
    }
    // The actual login owner, not HOME, USER or an SSH environment claim.
    let console = std::fs::symlink_metadata("/dev/console").map_err(|_| refused())?;
    if !console.file_type().is_char_device() || console.uid() != uid {
        return Err(refused());
    }
    let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut found = std::ptr::null_mut();
    if unsafe {
        libc::getpwuid_r(
            uid,
            entry.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut found,
        )
    } != 0
        || found.is_null()
    {
        return Err(refused());
    }
    let home = PathBuf::from(
        unsafe { CStr::from_ptr((*found).pw_dir) }
            .to_str()
            .map_err(|_| refused())?,
    );
    let metadata = std::fs::symlink_metadata(&home).map_err(|_| refused())?;
    if !home.is_absolute()
        || !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != uid
        || metadata.mode() & 0o022 != 0
        || std::fs::canonicalize(&home).map_err(|_| refused())? != home
    {
        return Err(refused());
    }
    Ok(home.join(".nessie").join("personal-inference"))
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn protected_root() -> Result<PathBuf, NativeError> {
    Err(NativeError::new("EXECUTOR_PERSONAL_STATE_UNSUPPORTED"))
}

/// Credential mutation has no development-build exception. Native unit tests
/// exercise the primitives directly; an unsigned helper cannot activate auth.
pub fn require_release() -> Result<(), NativeError> {
    #[cfg(windows)]
    {
        nessie_windows_provenance::require_release_signature(option_env!(
            "NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"
        ))
        .map_err(|_| NativeError::new("EXECUTOR_PERSONAL_STATE_RELEASE_REJECTED"))
    }
    #[cfg(target_os = "macos")]
    {
        let executable = std::env::current_exe()
            .map_err(|_| NativeError::new("EXECUTOR_PERSONAL_STATE_RELEASE_REJECTED"))?;
        crate::macos_provenance::require_file(&executable)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Err(NativeError::new("EXECUTOR_PERSONAL_STATE_UNSUPPORTED"))
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;
    #[test]
    fn personal_context_uses_the_actual_console_owner() {
        let uid = unsafe { libc::getuid() };
        let console = std::fs::metadata("/dev/console").unwrap();
        if uid == 0 || uid != unsafe { libc::geteuid() } || console.uid() != uid {
            assert!(protected_root().is_err());
        } else {
            let root = protected_root().unwrap();
            assert!(root.is_absolute());
            assert!(root.ends_with(".nessie/personal-inference"));
        }
    }
}
