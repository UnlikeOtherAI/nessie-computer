//! The identity Windows shows this app's toasts under.
//!
//! An unpackaged Win32 app's toasts need an application identity Windows
//! knows about. The installer's **Nessie Computer** Start menu shortcut
//! carries it (`System.AppUserModel.ID`). A build run without the installer
//! has no shortcut, so before a toast the app also names its identity for this
//! person under `HKCU\Software\Classes\AppUserModelId`. Saves never post
//! toasts; only program requests do.

/// Names this app's toasts "Nessie Computer" in Windows's notification list.
/// Written every time rather than once: it is idempotent, and a person who
/// cleared it must not lose every later toast without a trace.
#[cfg(windows)]
pub(crate) fn register_identity(identifier: &str) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
    let key = format!("Software\\Classes\\AppUserModelId\\{identifier}");
    crate::registry::write_string(HKEY_CURRENT_USER, &key, Some("DisplayName"), "Nessie Computer")
        .map_err(|status| format!("Windows could not register this app's notifications (error {status})."))
}

#[cfg(not(windows))]
pub(crate) fn register_identity(_: &str) -> Result<(), String> {
    Ok(())
}
