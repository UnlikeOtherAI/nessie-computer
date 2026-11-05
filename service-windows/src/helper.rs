//! Owner-only state, established and proved through the packaged native helper.
//!
//! Windows reports no uid and `0o666`-shaped modes, so privacy here is a DACL
//! and reading one needs Win32. The executor already ships that adapter — the
//! helper's `secure-directory` and `verify-owner-only` commands — and the
//! service uses exactly those, so the state root it creates carries the same
//! DACL the CLI later insists on. Running as `NT SERVICE\NessieExecutor` makes
//! that DACL the service account plus SYSTEM, which is what keeps pairing
//! material out of every person's profile.
//!
//! The helper's bytes are pinned in the runtime manifest, verified before this
//! module is ever called; nothing here reaches for an executable beside it.

use std::{
    path::Path,
    process::{Command, Stdio},
};

#[derive(Debug, PartialEq, Eq)]
pub enum HelperVerdict {
    Accepted,
    Rejected(String),
}

/// The helper answers with one JSON line. Anything else — no line, a truncated
/// line, a status this reader does not know — is a rejection, never a pass.
pub fn parse_helper_answer(answer: &str) -> HelperVerdict {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(answer.trim()) else {
        return HelperVerdict::Rejected("EXECUTOR_STATE_SECURITY_UNREADABLE".to_owned());
    };
    match parsed.get("status").and_then(serde_json::Value::as_str) {
        Some("secured") | Some("verified") => HelperVerdict::Accepted,
        _ => HelperVerdict::Rejected(
            parsed
                .get("code")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("EXECUTOR_STATE_SECURITY_REJECTED")
                .to_owned(),
        ),
    }
}

fn run(helper: &Path, command: &str, path: &Path) -> Result<(), String> {
    let output = Command::new(helper)
        .arg(command)
        .arg(path)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| "Nessie Executor could not run its packaged state-security helper.".to_owned())?;
    match parse_helper_answer(&String::from_utf8_lossy(&output.stdout)) {
        HelperVerdict::Accepted => Ok(()),
        // The code is a stable identifier from a binary we ship, not a path or a
        // secret, so naming it is what makes a refusal diagnosable.
        HelperVerdict::Rejected(code) => {
            Err(format!("Nessie Executor state is not owner-only ({code})."))
        }
    }
}

/// Creates the directory if absent and gives it an explicit, non-inherited DACL
/// granting full control to this account and SYSTEM alone. The helper's own
/// `secure-directory` ends by reading that DACL back, which is why there is no
/// separate verify call beside this one: establishing and proving are the same
/// command's job, and a DACL that did not take is indistinguishable from one
/// never asked for.
pub fn secure_directory(helper: &Path, path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|_| "Nessie Executor could not create its state directory.".to_owned())?;
    run(helper, "secure-directory", path)
}

/// Establishes a directory the **service account** owns, for the installer's
/// one bootstrap call.
///
/// Windows Installer runs that call as SYSTEM, before the service has ever
/// started, so `secure-directory` — which owns the directory to whoever is
/// running — would hand the state root to SYSTEM and lock the service account
/// out of its own state. `secure-service-directory` names the service's virtual
/// account instead, which is why the two are separate commands rather than one
/// with a flag.
pub fn secure_service_directory(helper: &Path, path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|_| "Nessie Executor could not create its state directory.".to_owned())?;
    run(helper, "secure-service-directory", path)
}

#[cfg(test)]
mod tests {
    use super::{parse_helper_answer, HelperVerdict};

    #[test]
    fn the_helpers_two_accepting_answers_are_the_only_ones() {
        assert_eq!(parse_helper_answer(r#"{"status":"secured"}"#), HelperVerdict::Accepted);
        assert_eq!(parse_helper_answer("{\"status\":\"verified\"}\n"), HelperVerdict::Accepted);
    }

    #[test]
    fn a_rejection_carries_the_helpers_own_code() {
        assert_eq!(
            parse_helper_answer(r#"{"status":"rejected","code":"EXECUTOR_STATE_SECURITY_REJECTED"}"#),
            HelperVerdict::Rejected("EXECUTOR_STATE_SECURITY_REJECTED".to_owned()),
        );
        assert_eq!(
            parse_helper_answer(r#"{"status":"rejected","code":"EXECUTOR_STATE_SECURITY_UNSUPPORTED"}"#),
            HelperVerdict::Rejected("EXECUTOR_STATE_SECURITY_UNSUPPORTED".to_owned()),
        );
    }

    /// A helper that printed nothing, was killed, or answered in a shape this
    /// reader does not know must never be read as "secured".
    #[test]
    fn an_unreadable_answer_is_a_rejection_rather_than_a_pass() {
        for answer in ["", "   ", "not json", r#"{"status":"secured"#, r#"{"status":"unknown"}"#, "{}"] {
            assert!(
                matches!(parse_helper_answer(answer), HelperVerdict::Rejected(_)),
                "answer {answer:?} must be a rejection",
            );
        }
    }
}
