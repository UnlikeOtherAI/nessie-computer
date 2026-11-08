//! Why a team stopped, as both Windows supervisors report it.
//!
//! A daemon or `connect` that exits writes its reason as the last line of
//! standard error, a sentence the CLI wrote for a person. The supervisors keep
//! that line (bounded, single-line) and report it as `failure.message`. When
//! the line is one of the fixed refusals the API raises beside a known error
//! code, `failure.code` names it, so the shared console's one translator,
//! keyed by code, can explain it and offer its remedy. The words a person
//! reads live in the console; this file only recognises the literals.

use std::{
    io::{BufRead, BufReader, Read},
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};

const MAX_MESSAGE_CHARACTERS: usize = 400;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub message: String,
}

/// What a person can do about a failure from this computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Remedy {
    /// Stop and start the team's connection here: another copy took it, or its
    /// connection went quiet.
    Restart,
    /// Propose the same settings again at a newer revision, then reconnect.
    Repropose,
    /// Something has to be confirmed in Nessie.
    OpenNessie,
}

impl Remedy {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "restartExecutor" => Ok(Self::Restart),
            "reProposePolicy" => Ok(Self::Repropose),
            "openNessie" => Ok(Self::OpenNessie),
            _ => Err("That fix is not available here.".to_owned()),
        }
    }
}

/// The refusals the API raises beside a code, as the CLI prints them. Matched
/// by containment, as the macOS app has always matched them.
const KNOWN: [(&str, &str); 11] = [
    ("Executor descriptor revisions cannot move backwards.", "EXECUTOR_DESCRIPTOR_ROLLBACK"),
    ("A descriptor revision cannot describe two different policies.", "EXECUTOR_DESCRIPTOR_REVISION_CONFLICT"),
    ("Executor connection is fenced.", "EXECUTOR_CONNECTION_FENCED"),
    ("Executor descriptor proof is invalid.", "EXECUTOR_DAEMON_PROOF_INVALID"),
    ("Executor proof is invalid.", "EXECUTOR_DAEMON_PROOF_INVALID"),
    ("Executor heartbeat is stale.", "EXECUTOR_HEARTBEAT_STALE"),
    ("Executor control call is stale.", "EXECUTOR_HEARTBEAT_STALE"),
    ("No active executor enrollment is ready to confirm.", "FINGERPRINT_NOT_CONFIRMED"),
    ("The confirmation fingerprint does not match the pending executor.", "FINGERPRINT_NOT_CONFIRMED"),
    ("No active executor enrollment is ready", "ENROLLMENT_EXPIRED"),
    ("Executor API request timed out.", "EXECUTOR_API_TIMEOUT"),
];

pub fn classify(message: &str) -> Failure {
    let message: String = message.trim().chars().take(MAX_MESSAGE_CHARACTERS).collect();
    let code = KNOWN.iter().find(|(literal, _)| message.contains(literal)).map(|(_, code)| (*code).to_owned());
    Failure { code, message }
}

/// Whether restarting may heal it. A timeout or a refusal this build does not
/// recognise may (a network not up yet at login, say); a recognised refusal —
/// a fenced connection, a rejected key, a stale revision, an unconfirmed
/// pairing — never does, so it waits for the owner's remedy instead of being
/// retried, as on macOS.
pub fn retriable(failure: &Failure) -> bool {
    failure.code.as_deref().is_none_or(|code| code == "EXECUTOR_API_TIMEOUT")
}

/// The remedy a recognised failure has. Unrecognised failures have none: the
/// supervisor keeps retrying them and the console quotes the message.
pub fn remedy(failure: &Failure) -> Option<Remedy> {
    match failure.code.as_deref()? {
        "EXECUTOR_DESCRIPTOR_ROLLBACK" | "EXECUTOR_DESCRIPTOR_REVISION_CONFLICT" => Some(Remedy::Repropose),
        "EXECUTOR_CONNECTION_FENCED" | "EXECUTOR_HEARTBEAT_STALE" => Some(Remedy::Restart),
        "FINGERPRINT_NOT_CONFIRMED" | "ENROLLMENT_EXPIRED" => Some(Remedy::OpenNessie),
        _ => None,
    }
}

#[derive(Debug, Default)]
struct Tail {
    line: Option<String>,
    finished: bool,
}

/// The last non-empty line a child wrote to standard error, read on its own
/// thread so the child never blocks on a full pipe.
#[derive(Debug, Clone, Default)]
pub struct StderrTail(Arc<(Mutex<Tail>, Condvar)>);

impl StderrTail {
    pub fn watch(stderr: impl Read + Send + 'static) -> Self {
        let tail = Self::default();
        let shared = tail.0.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let text = String::from_utf8_lossy(&line);
                let text = text.trim();
                if text.is_empty() || text.chars().any(char::is_control) {
                    continue;
                }
                if let Ok(mut held) = shared.0.lock() {
                    held.line = Some(text.chars().take(MAX_MESSAGE_CHARACTERS).collect());
                }
            }
            if let Ok(mut held) = shared.0.lock() {
                held.finished = true;
            }
            shared.1.notify_all();
        });
        tail
    }

    pub fn last(&self) -> Option<String> {
        self.0 .0.lock().ok().and_then(|held| held.line.clone())
    }

    /// The last line once the child has exited: waits, at most `wait`, for
    /// the reader to reach the end of the pipe, so a reason written just
    /// before exiting is not missed.
    pub fn settled(&self, wait: Duration) -> Option<String> {
        let (lock, finished) = &*self.0;
        let held = lock.lock().ok()?;
        let (held, _) = finished.wait_timeout_while(held, wait, |held| !held.finished).ok()?;
        held.line.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::{classify, remedy, Remedy, StderrTail};

    #[test]
    fn a_known_refusal_names_its_code_and_remedy() {
        let fenced = classify("Error: Executor connection is fenced.\n");
        assert_eq!(fenced.code.as_deref(), Some("EXECUTOR_CONNECTION_FENCED"));
        assert_eq!(fenced.message, "Error: Executor connection is fenced.");
        assert_eq!(remedy(&fenced), Some(Remedy::Restart));
        let rollback = classify("Executor descriptor revisions cannot move backwards.");
        assert_eq!(remedy(&rollback), Some(Remedy::Repropose));
        assert_eq!(classify("Executor descriptor proof is invalid.").code.as_deref(),
            Some("EXECUTOR_DAEMON_PROOF_INVALID"));
        assert_eq!(remedy(&classify("No active executor enrollment is ready to confirm.")), Some(Remedy::OpenNessie));
        assert_eq!(remedy(&classify("Executor API request timed out.")), None);
    }

    #[test]
    fn only_a_timeout_or_an_unrecognised_refusal_is_retried() {
        assert!(super::retriable(&classify("Executor API request timed out.")));
        assert!(super::retriable(&classify("getaddrinfo ENOTFOUND api.nessie.works")));
        for refusal in ["Executor connection is fenced.", "Executor proof is invalid.",
            "Executor descriptor revisions cannot move backwards.", "No active executor enrollment is ready"] {
            assert!(!super::retriable(&classify(refusal)), "{refusal}");
        }
    }

    #[test]
    fn an_unknown_failure_is_quoted_bounded_and_has_no_remedy() {
        let failure = classify(&"x".repeat(1_000));
        assert_eq!(failure.code, None);
        assert_eq!(failure.message.chars().count(), 400);
        assert_eq!(remedy(&failure), None);
        assert_eq!(serde_json::to_value(classify("Network unreachable.")).unwrap(),
            serde_json::json!({ "message": "Network unreachable." }));
    }

    #[test]
    fn remedies_are_the_three_ids_the_console_sends() {
        assert_eq!(Remedy::parse("restartExecutor"), Ok(Remedy::Restart));
        assert_eq!(Remedy::parse("reProposePolicy"), Ok(Remedy::Repropose));
        assert_eq!(Remedy::parse("openNessie"), Ok(Remedy::OpenNessie));
        for other in ["restart", "repropose", "open_nessie", "reinstall"] {
            assert!(Remedy::parse(other).is_err(), "{other}");
        }
    }

    #[test]
    fn the_tail_keeps_the_last_readable_line() {
        let tail = StderrTail::watch(&b"starting\n\nExecutor heartbeat is stale.\n   \n"[..]);
        assert_eq!(tail.settled(std::time::Duration::from_secs(5)).as_deref(), Some("Executor heartbeat is stale."));
        assert_eq!(tail.last().as_deref(), Some("Executor heartbeat is stale."));
        assert_eq!(StderrTail::default().settled(std::time::Duration::from_millis(1)), None);
    }
}
