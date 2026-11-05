//! The service's own log, in the folder the tray's **Open logs folder** opens.
//!
//! A service has no console and no person watching it start, so the one thing it
//! must not do is fail silently: every refusal a person could act on — an
//! unsigned build, a tampered runtime, a state root that would not secure —
//! lands here. What it never records is what the rest of the service never
//! reports either: no challenge, no key, no child-process output.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::paths::logs_root;

const LOG_FILE: &str = "service.log";

/// Seconds since the epoch. A service log is read next to Event Viewer entries
/// and the daemon's own logs, so an absolute, sortable stamp is what makes the
/// three line up; formatting it as a calendar date would cost a dependency for
/// nothing.
fn stamp() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|since| since.as_secs()).unwrap_or_default()
}

/// Appends one line. Logging can never fail the operation it is describing: a
/// full disk or a locked file must not stop a daemon from starting.
pub fn log_line(root: &Path, message: &str) {
    let directory = logs_root(root);
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    if let Ok(mut file) = OpenOptions::new().append(true).create(true).open(directory.join(LOG_FILE))
    {
        let _ = writeln!(file, "{} {message}", stamp());
    }
}

#[cfg(test)]
mod tests {
    use super::{log_line, LOG_FILE};
    use crate::paths::logs_root;

    #[test]
    fn a_line_lands_in_the_folder_the_tray_opens() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        log_line(directory.path(), "the packaged runtime did not pass integrity verification");
        let written = std::fs::read_to_string(logs_root(directory.path()).join(LOG_FILE))
            .expect("the log must be readable");
        assert!(written.contains("did not pass integrity verification"));
        assert!(written.ends_with('\n'));
    }

    /// Logging is diagnostics, never a precondition: a root that cannot be
    /// written to must not stop the service from doing its work.
    #[test]
    fn a_log_that_cannot_be_written_is_not_an_error() {
        log_line(std::path::Path::new("/nessie-executor-nonexistent-root"), "ignored");
    }
}
