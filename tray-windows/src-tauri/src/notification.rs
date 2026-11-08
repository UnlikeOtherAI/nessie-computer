//! Windows toasts for the console, such as "Settings saved" after an autosave.
//!
//! The console decides when to notify; this module decides what a toast may
//! carry. The text arrives from a webview, so it is bounded and single-line
//! before it reaches Windows. A refused toast, a failed identity registration,
//! or a failure the notification plugin reports is an error the console
//! answers with its inline "Saved" text instead. The plugin hands the toast to
//! Windows on a background task and does not report whether Windows then
//! displayed it (Focus Assist, for one, suppresses it without an error).
//!
//! An unpackaged Win32 app's toasts are shown under an application identity
//! Windows knows about. The installer's **Nessie Computer** Start menu
//! shortcut carries it (`System.AppUserModel.ID`). A build run without the
//! installer has no shortcut, so the tray also names its identity for this
//! person under `HKCU\Software\Classes\AppUserModelId` before a toast.

use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;

const MAX_TITLE_CHARACTERS: usize = 64;
const MAX_BODY_CHARACTERS: usize = 200;

/// What a toast may say: some text, short enough to read at a glance, on one
/// line, with nothing a terminal or the notification XML would interpret.
pub fn validate(title: &str, body: &str) -> Result<(), String> {
    for (text, limit, field) in [
        (title, MAX_TITLE_CHARACTERS, "title"),
        (body, MAX_BODY_CHARACTERS, "message"),
    ] {
        if text.trim().is_empty() {
            return Err(format!("A notification needs a {field}."));
        }
        if text.chars().count() > limit {
            return Err(format!("A notification {field} is at most {limit} characters."));
        }
        if text.chars().any(char::is_control) {
            return Err(format!("A notification {field} must be a single line of text."));
        }
    }
    Ok(())
}

/// Names this app's toasts "Nessie Computer" in Windows's notification list.
/// Written every time rather than once: it is idempotent, and a person who
/// cleared it must not lose every later toast without a trace.
#[cfg(windows)]
fn register_identity(identifier: &str) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
    let key = format!("Software\\Classes\\AppUserModelId\\{identifier}");
    crate::registry::write_string(HKEY_CURRENT_USER, &key, Some("DisplayName"), "Nessie Computer")
        .map_err(|status| format!("Windows could not register this app's notifications (error {status})."))
}

#[cfg(not(windows))]
fn register_identity(_: &str) -> Result<(), String> {
    Ok(())
}

pub fn show<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) -> Result<(), String> {
    validate(title, body)?;
    register_identity(&app.config().identifier)?;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| format!("Windows could not show the notification: {error}"))
}

#[tauri::command]
pub fn executor_notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    show(&app, &title, &body)
}

#[cfg(test)]
mod tests {
    use super::validate;

    #[test]
    fn an_autosave_confirmation_is_accepted() {
        assert_eq!(validate("Settings saved", "Commands for UnlikeOtherAI / Platform"), Ok(()));
        assert_eq!(validate(&"t".repeat(64), &"b".repeat(200)), Ok(()));
        // Characters, not bytes: a team name in another script is not penalised.
        assert_eq!(validate("Nastavení uloženo", &"č".repeat(200)), Ok(()));
    }

    #[test]
    fn empty_oversized_or_multi_line_text_is_refused() {
        for (title, body) in [
            ("", "Commands for Platform"),
            ("   ", "Commands for Platform"),
            ("Settings saved", ""),
            (&"t".repeat(65) as &str, "Commands for Platform"),
            ("Settings saved", &"b".repeat(201) as &str),
            ("Settings\nsaved", "Commands for Platform"),
            ("Settings saved", "Commands\tfor Platform"),
            ("Settings saved", "Commands for Platform\u{1b}[31m"),
        ] {
            assert!(validate(title, body).is_err(), "{title:?} / {body:?} must be refused");
        }
    }
}
