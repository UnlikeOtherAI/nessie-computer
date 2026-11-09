//! The installer's handover around changing the files
//! (`nessie_windows_common::install_handover`).
//!
//! `--close-for-install` runs from the package's own copy of this binary
//! (the MSI Binary table) before any file changes, so the new code runs even
//! while an older release is installed. It closes everything that runs from
//! the install folder other than the service, which the installer stops
//! itself, and notes each Windows app it closed. `--reopen-after-install`
//! runs the installed binary once the service is back and reopens those apps,
//! each in its own session for the person signed in there; a rollback runs it
//! too, for the release the rollback restores.
//!
//! The install folder is derived here, never taken from the command line, for
//! the reason `--secure-state-root` derives its paths.

use crate::setup_report::Refusal;

/// Long enough for a team to finish what it is doing and stop; the apps get a fifth of it.
#[cfg(windows)]
const GRACE: std::time::Duration = std::time::Duration::from_secs(30);

/// The apps closed for this install, kept in the service's own directory,
/// which only the service account and SYSTEM may write.
#[cfg(windows)]
const RECORD: &str = "installer-open-apps.json";

#[cfg(windows)]
fn install_folder() -> Result<std::path::PathBuf, Refusal> {
    nessie_windows_common::update_admission::known_folder(&windows_sys::Win32::UI::Shell::FOLDERID_ProgramFiles)
        .map(|folder| folder.join(nessie_windows_common::INSTALL_DIRECTORY_NAME))
        .map_err(|_| Refusal::new("install_handover.folder_unlocated"))
}

#[cfg(windows)]
pub fn close_for_install() -> Result<(), Refusal> {
    use nessie_windows_common::install_handover;
    let folder = install_folder()?;
    let closing = install_handover::close(&folder, GRACE)
        .map_err(|_| Refusal::new("install_handover.still_running"))?;
    if !closing.apps.is_empty() {
        // Losing the note only means the apps open at the next sign-in instead.
        if let (Ok(root), Ok(bytes)) = (crate::paths::service_root(), serde_json::to_vec(&closing.apps)) {
            if root.is_dir() {
                let _ = std::fs::write(root.join(RECORD), bytes);
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
pub fn reopen_after_install() -> Result<(), Refusal> {
    use nessie_windows_common::install_handover::{self, OpenApp};
    let record = crate::paths::service_root()
        .map_err(|_| Refusal::new("install_handover.record_unavailable"))?.join(RECORD);
    let Ok(bytes) = std::fs::read(&record) else { return Ok(()) };
    let _ = std::fs::remove_file(&record);
    let apps: Vec<OpenApp> = serde_json::from_slice(&bytes)
        .map_err(|_| Refusal::new("install_handover.record_unreadable"))?;
    if apps.len() > 64 {
        return Err(Refusal::new("install_handover.record_unreadable"));
    }
    install_handover::reopen(&apps, &install_folder()?, option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"));
    Ok(())
}

#[cfg(not(windows))]
pub fn close_for_install() -> Result<(), Refusal> {
    Err(Refusal::with("install_handover.unsupported", "The installer handover requires Windows."))
}

#[cfg(not(windows))]
pub fn reopen_after_install() -> Result<(), Refusal> {
    Err(Refusal::with("install_handover.unsupported", "The installer handover requires Windows."))
}
