//! Removing one paired connection from this computer.
//!
//! Both Windows supervisors remove a connection the same way: stop its daemon,
//! then run the packaged CLI's `unpair`. The CLI refuses while a daemon still
//! holds the connection, tells Nessie the computer is signing off (best
//! effort), deletes the connection's state directory and prints exactly one
//! JSON line: `{"status":"removed","signedOff":true|false}`.
//!
//! The tray runs it for user-session connections and the service for its own,
//! so the argv and the answer's shape are stated once, here, and tested on any
//! host.

use std::path::Path;

/// The one-shot command for one connection's state directory. `--json` makes
/// the CLI's answer the single line [`parse_unpair_output`] reads.
pub fn unpair_arguments(state_dir: &Path) -> Vec<String> {
    vec![
        "unpair".to_owned(),
        "--json".to_owned(),
        "--state-dir".to_owned(),
        state_dir.display().to_string(),
    ]
}

const UNREADABLE: &str = "Couldn’t confirm whether this team was removed. Check Teams.";

/// Whether Nessie acknowledged the sign-off, read from the CLI's raw output.
/// Anything but the one documented line is a failure: an answer this reader
/// does not recognise must never read as a removed connection.
pub fn parse_unpair_output(output: &[u8]) -> Result<bool, String> {
    let text = std::str::from_utf8(output).map_err(|_| UNREADABLE.to_owned())?;
    let line = text.trim();
    if line.is_empty() || line.contains('\n') {
        return Err(UNREADABLE.to_owned());
    }
    signed_off(&serde_json::from_str(line).map_err(|_| UNREADABLE.to_owned())?)
}

/// The same rule for an answer a caller has already parsed as one JSON value.
pub fn signed_off(answer: &serde_json::Value) -> Result<bool, String> {
    if answer.get("status").and_then(serde_json::Value::as_str) != Some("removed") {
        return Err(UNREADABLE.to_owned());
    }
    answer
        .get("signedOff")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| UNREADABLE.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{parse_unpair_output, signed_off, unpair_arguments};
    use std::path::Path;

    #[test]
    fn unpair_names_one_state_directory_and_asks_for_json() {
        assert_eq!(
            unpair_arguments(Path::new("/state/connection")),
            vec!["unpair", "--json", "--state-dir", "/state/connection"],
        );
    }

    #[test]
    fn the_removed_line_reports_whether_nessie_heard_the_sign_off() {
        assert_eq!(parse_unpair_output(b"{\"status\":\"removed\",\"signedOff\":true}\n"), Ok(true));
        assert_eq!(parse_unpair_output(b"{\"status\":\"removed\",\"signedOff\":false}"), Ok(false));
    }

    #[test]
    fn anything_else_is_a_failure_and_never_a_removal() {
        for output in [
            &b""[..],
            b"   \n",
            b"not json",
            b"{}",
            b"{\"status\":\"removed\"}",
            b"{\"status\":\"removed\",\"signedOff\":\"yes\"}",
            b"{\"status\":\"refused\",\"signedOff\":true}",
            b"{\"status\":\"removed\",\"signedOff\":true}\n{\"status\":\"removed\",\"signedOff\":true}",
            b"\xff\xfe",
        ] {
            assert!(parse_unpair_output(output).is_err(), "output {output:?} must be refused");
        }
    }

    #[test]
    fn a_parsed_answer_follows_the_same_rule() {
        assert_eq!(signed_off(&serde_json::json!({"status": "removed", "signedOff": true})), Ok(true));
        assert!(signed_off(&serde_json::json!({"status": "removed"})).is_err());
        assert!(signed_off(&serde_json::Value::Null).is_err());
    }
}
