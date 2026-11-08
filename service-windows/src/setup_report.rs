//! Why an installer step refused, written where someone can read it later.
//!
//! Windows Installer runs the setup modes as custom actions and keeps only
//! their exit code: this binary has no console, and an executable custom
//! action's output never reaches the MSI log, which records just "returned
//! actual error code 1" before rolling back with 1603. So a refusal goes to
//! standard error, for anyone running the mode by hand, and to the Windows
//! Application event log under the source [`EVENT_SOURCE`].
//!
//! Every line starts with a stable reason code. It carries only codes and fixed
//! sentences from binaries this package ships: never a path, a key or a child
//! process's output beyond the code it answered with.

/// The Application log source setup refusals are written under.
pub const EVENT_SOURCE: &str = "Nessie Computer Setup";

/// One refusal: a stable code and, when it helps, a fixed detail.
#[derive(Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub detail: Option<String>,
}

impl Refusal {
    pub fn new(code: &'static str) -> Self {
        Self { code, detail: None }
    }

    pub fn with(code: &'static str, detail: impl Into<String>) -> Self {
        Self { code, detail: Some(detail.into()) }
    }

    /// The updater setup's native helper refused. Its answer names the reason
    /// as one code; anything else it printed is not repeated.
    pub fn helper(code: &'static str, stdout: &[u8], exit: Option<i32>) -> Self {
        let answer = helper_code(stdout).unwrap_or_else(|| "unreadable".to_owned());
        let exit = exit.map_or_else(|| "none".to_owned(), |exit| exit.to_string());
        Self::with(code, format!("helper={answer} exit={exit}"))
    }

    /// `<mode>: <code>[ <detail>]`, the line stderr and the event log carry.
    pub fn line(&self, mode: &str) -> String {
        match &self.detail {
            Some(detail) => format!("Nessie Computer setup {mode} refused: {} {detail}", self.code),
            None => format!("Nessie Computer setup {mode} refused: {}", self.code),
        }
    }
}

/// The native helper answers an update setup refusal with `{"error":"<code>"}`
/// on one line. Only a code made of letters, digits, `.` and `_` is believed.
pub fn helper_code(stdout: &[u8]) -> Option<String> {
    let line = std::str::from_utf8(stdout).ok()?.lines().next()?;
    let answer: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let code = answer.as_object()?.get("error")?.as_str()?;
    let valid = !code.is_empty()
        && code.len() <= 96
        && code.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'_');
    valid.then(|| code.to_owned())
}

/// Writes the refusal to the Application event log and returns its line for
/// standard error. Reporting never changes the outcome: an event log that
/// cannot be written leaves the exit code and stderr as they are.
pub fn report(mode: &str, refusal: &Refusal) -> String {
    let line = refusal.line(mode);
    write_event(&line);
    line
}

#[cfg(windows)]
fn write_event(line: &str) {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::System::EventLog::{
        DeregisterEventSource, RegisterEventSourceW, ReportEventW, EVENTLOG_ERROR_TYPE,
    };
    let wide = |value: &str| OsStr::new(value).encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    let source = wide(EVENT_SOURCE);
    let text = wide(line);
    let handle = unsafe { RegisterEventSourceW(std::ptr::null(), source.as_ptr()) };
    if handle.is_null() {
        return;
    }
    let strings = [text.as_ptr()];
    unsafe {
        ReportEventW(
            handle,
            EVENTLOG_ERROR_TYPE,
            0,
            1,
            std::ptr::null_mut(),
            1,
            0,
            strings.as_ptr(),
            std::ptr::null(),
        );
        DeregisterEventSource(handle);
    }
}

#[cfg(not(windows))]
fn write_event(_line: &str) {}

#[cfg(test)]
mod tests {
    use super::{helper_code, Refusal};

    #[test]
    fn the_helpers_code_is_read_from_its_one_line_answer() {
        assert_eq!(
            helper_code(b"{\"error\":\"update.installed_tray_unverified\"}\n").as_deref(),
            Some("update.installed_tray_unverified"),
        );
        assert_eq!(helper_code(b"{\"error\":\"EXECUTOR_STATE_SECURITY_REJECTED\"}").as_deref(),
            Some("EXECUTOR_STATE_SECURITY_REJECTED"));
    }

    #[test]
    fn anything_but_a_plain_code_is_never_repeated() {
        for stdout in [
            &b""[..],
            b"not json",
            b"{\"error\":\"C:\\\\Users\\\\person\\\\secret\"}",
            b"{\"error\":\"has space\"}",
            b"{\"error\":42}",
            b"{\"status\":\"rejected\"}",
            b"[\"update.x\"]",
        ] {
            assert_eq!(helper_code(stdout), None, "{:?}", String::from_utf8_lossy(stdout));
        }
        let long = format!("{{\"error\":\"{}\"}}", "a".repeat(97));
        assert_eq!(helper_code(long.as_bytes()), None);
    }

    #[test]
    fn a_refusal_line_leads_with_its_stable_code() {
        let refusal = Refusal::helper(
            "updater_setup.helper_refused",
            b"{\"error\":\"update.installed_tray_unverified\"}\n",
            Some(1),
        );
        assert_eq!(
            refusal.line("--secure-updater-root"),
            "Nessie Computer setup --secure-updater-root refused: updater_setup.helper_refused \
             helper=update.installed_tray_unverified exit=1",
        );
        let unreadable = Refusal::helper("updater_setup.helper_refused", b"C:\\private\\path", None);
        assert_eq!(unreadable.detail.as_deref(), Some("helper=unreadable exit=none"));
        assert_eq!(
            Refusal::new("updater_setup.runtime_unlocated").line("--secure-updater-root"),
            "Nessie Computer setup --secure-updater-root refused: updater_setup.runtime_unlocated",
        );
    }
}
