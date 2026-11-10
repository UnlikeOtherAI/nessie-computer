//! Nessie Computer's own installed entrypoints must share the current native floor.
use crate::{managed_release::Release, managed_runtime_context, protocol::NativeError};
use std::{fs, path::{Path, PathBuf}};

fn refused() -> NativeError { NativeError::new("EXECUTOR_INSTALLED_CUSTODY_UNVERIFIED") }
fn present(path: &Path) -> Result<bool, NativeError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(refused()),
    }
}
pub fn verify(_release: &Release) -> Result<(), NativeError> {
    // Homebrew's old launchd consumer starts Node directly. Until that
    // installation is replaced, closing one process is not a compatibility floor.
    for prefix in ["/opt/homebrew", "/usr/local"] {
        if present(&Path::new(prefix).join("opt/nessie-executor"))? { return Err(refused()); }
    }
    let home = managed_runtime_context::home()?;
    for applications in [PathBuf::from("/Applications"), home.join("Applications")] {
        for name in ["Nessie Executor.app", "NessieExecutorMenuBar.app"] {
            let app = applications.join(name);
            if !present(&app)? { continue; }
            crate::macos_provenance::require_independent_app(&app)?;
        }
    }
    Ok(())
}
