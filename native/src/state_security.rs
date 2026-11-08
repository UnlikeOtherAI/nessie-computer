//! Owner-only private state, proved the way the host proves it.
//!
//! POSIX supervisors read `uid` and mode bits directly and never call the
//! helper. Windows reports `0o666`-style modes and no uid, so there is nothing
//! for the supervisor to read: privacy there is a DACL, and establishing and
//! reading one needs Win32. These two commands are that adapter, and nothing
//! else in the helper depends on them.

use crate::protocol::NativeError;

/// The four codes a supervisor may read back. All four are part of the
/// contract on every host, but each build can only ever return some of them:
/// only Windows verifies a DACL, and only the other hosts refuse to try.
#[cfg_attr(windows, allow(dead_code))]
pub const UNSUPPORTED: &str = "EXECUTOR_STATE_SECURITY_UNSUPPORTED";
#[cfg_attr(not(windows), allow(dead_code))]
pub const REJECTED: &str = "EXECUTOR_STATE_SECURITY_REJECTED";
#[cfg_attr(not(windows), allow(dead_code))]
pub const IO_FAILURE: &str = "EXECUTOR_STATE_SECURITY_IO_FAILURE";
#[cfg_attr(not(windows), allow(dead_code))]
pub const NOT_FOUND: &str = "EXECUTOR_STATE_SECURITY_NOT_FOUND";

/// Create the directory if absent and give it an explicit, non-inherited DACL
/// granting full control to the current user and SYSTEM alone.
pub fn secure_directory(path: &str) -> Result<(), NativeError> {
    imp::secure_directory(path)
}

pub fn verify_service_context() -> Result<(), NativeError> {
    #[cfg(windows)]
    {
        nessie_windows_provenance::require_release_signature(option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"))
            .map_err(|_| NativeError::new("EXECUTOR_SERVICE_PUBLISHER_REJECTED"))?;
        imp::verify_service_context()
    }
    #[cfg(not(windows))]
    { Err(NativeError::new(UNSUPPORTED)) }
}

/// Establish the standalone service state root with the service virtual
/// account as owner. Windows Installer executes this as SYSTEM before the
/// service starts, so using the current token here would permanently lock the
/// actual service out of its own state.
pub fn secure_service_directory(path: &str) -> Result<(), NativeError> {
    imp::secure_service_directory(path)
}

#[cfg(windows)]
pub fn verify_service_directory(path: &str) -> Result<(), NativeError> {
    imp::verify_service_directory(path)
}

/// Prove that a directory is still owned by the current user and that every ACE
/// on it admits only that user or SYSTEM, with nothing inherited.
pub fn verify_owner_only(path: &str) -> Result<(), NativeError> {
    imp::verify_owner_only(path)
}

/// Prove a private file is owned by the current account and its own DACL grants
/// access only to that account and SYSTEM. Files normally inherit the safe ACEs
/// from their protected parent, so inherited ACE flags are valid here.
///
/// "Owned by the current account" means the token user **or** the SID this
/// token stamps on what it creates, which for an elevated process is the
/// Administrators group. Windows chooses a new file's owner from the token, and
/// nothing in the supervisor can ask it to choose otherwise, so requiring the
/// token user alone rejected the supervisor's own writes whenever it ran
/// elevated — pairing could not save its state at all. For an ordinary account
/// the two SIDs are the same value, so the accepted set stays exactly one SID
/// and nothing is widened for the case that matters. The DACL check is
/// untouched either way: the file must still admit only the token user and
/// SYSTEM.
pub fn verify_owner_only_file(path: &str) -> Result<(), NativeError> {
    imp::verify_owner_only_file(path)
}

#[cfg(windows)]
pub fn verify_owner_only_handle(handle: windows_sys::Win32::Foundation::HANDLE) -> Result<(), NativeError> {
    imp::verify_owner_only_handle(handle)
}

#[cfg(windows)]
pub fn private_pipe_descriptor() -> Result<windows_sys::Win32::Security::PSECURITY_DESCRIPTOR, NativeError> {
    imp::private_pipe_descriptor()
}

/// A private file written by this token must keep the account as its owner
/// when a later ordinary tray reads what an elevated CLI wrote.
pub fn secure_owner_only_file(path: &str) -> Result<(), NativeError> {
    imp::secure_owner_only_file(path)
}

#[cfg(not(windows))]
mod imp {
    use super::{NativeError, UNSUPPORTED};

    pub fn secure_directory(_path: &str) -> Result<(), NativeError> {
        Err(NativeError::new(UNSUPPORTED))
    }

    pub fn secure_service_directory(_path: &str) -> Result<(), NativeError> {
        Err(NativeError::new(UNSUPPORTED))
    }

    pub fn verify_owner_only(_path: &str) -> Result<(), NativeError> {
        Err(NativeError::new(UNSUPPORTED))
    }

    pub fn verify_owner_only_file(_path: &str) -> Result<(), NativeError> {
        Err(NativeError::new(UNSUPPORTED))
    }

    pub fn secure_owner_only_file(_path: &str) -> Result<(), NativeError> {
        Err(NativeError::new(UNSUPPORTED))
    }
}

#[cfg(windows)]
#[path = "state_security/windows.rs"]
mod imp;

#[cfg(test)]
mod tests {
    use super::{secure_directory, verify_owner_only, verify_owner_only_file, IO_FAILURE, NOT_FOUND, REJECTED, UNSUPPORTED};

    /// The codes are part of the contract the supervisor reads, and none of
    /// them may carry a path or a reason a person should not see.
    #[test]
    fn the_codes_are_stable_and_name_no_path() {
        for code in [UNSUPPORTED, REJECTED, IO_FAILURE, NOT_FOUND] {
            assert!(code.starts_with("EXECUTOR_STATE_SECURITY_"));
            assert!(!code.contains('/') && !code.contains('\\'));
        }
    }

    /// POSIX supervisors prove privacy from `uid` and mode bits themselves, so
    /// the helper refuses rather than answering with a check it cannot make.
    #[cfg(not(windows))]
    #[test]
    fn a_posix_helper_refuses_the_windows_only_commands() {
        assert_eq!(secure_directory("/state/one").unwrap_err().code, UNSUPPORTED);
        assert_eq!(verify_owner_only("/state/one").unwrap_err().code, UNSUPPORTED);
    }

    /// On Windows the directory the helper just secured must verify, and a
    /// directory it never touched must not.
    #[cfg(windows)]
    #[test]
    fn a_secured_directory_verifies_and_an_untouched_one_does_not() {
        let root = std::env::temp_dir().join(format!("nessie-state-{}", std::process::id()));
        let secured = root.join("secured");
        let untouched = root.join("untouched");
        std::fs::create_dir_all(&untouched).expect("the test directory must be creatable");

        secure_directory(secured.to_str().expect("a UTF-8 test path")).expect("securing succeeds");
        verify_owner_only(secured.to_str().expect("a UTF-8 test path")).expect("it verifies");
        assert_eq!(
            verify_owner_only(untouched.to_str().expect("a UTF-8 test path")).unwrap_err().code,
            REJECTED,
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(windows)]
    #[test]
    fn a_file_in_a_secured_directory_accepts_its_inherited_private_aces() {
        let root = std::env::temp_dir().join(format!("nessie-state-file-{}", std::process::id()));
        let secured = root.join("secured");
        std::fs::create_dir_all(&root).expect("the test root must be creatable");
        secure_directory(secured.to_str().expect("a UTF-8 test path")).expect("securing succeeds");
        let file = secured.join("private.json");
        std::fs::write(&file, b"{}").expect("the inherited file must be writable");
        // Deliberately not stamped. An elevated test process creates this file
        // owned by the Administrators group rather than by its token user, and
        // so does the supervisor when it writes pairing state; a fixture that
        // corrected the owner first was hiding the fact that production refused
        // its own writes. The file is verified exactly as it was created.
        verify_owner_only_file(file.to_str().expect("a UTF-8 test path"))
            .expect("the inherited file DACL remains private");
        // The parent remains protected and valid: only this file overrides its
        // inherited DACL. A parent-only check would incorrectly accept it.
        let broad = secured.join("broad.json");
        std::fs::write(&broad, b"{}").expect("the ordinary file must be writable");
        let grant = std::process::Command::new("icacls")
            .arg(&broad)
            .args(["/grant", "*S-1-1-0:R"])
            .output()
            .expect("icacls must be available on Windows");
        assert!(grant.status.success(), "icacls must apply the explicit broad ACE");
        assert_eq!(
            verify_owner_only_file(broad.to_str().expect("a UTF-8 test path")).unwrap_err().code,
            REJECTED,
        );
        std::fs::remove_dir_all(&root).ok();
    }
}
