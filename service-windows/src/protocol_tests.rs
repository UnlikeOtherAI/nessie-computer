//! The control protocol's contract, asserted on its text in both directions.

use super::{
    parse_request, valid_identifier, workspace_operation_keys, Command, ExecutorStatus,
    Response, LOOPBACK_API_BASE_URLS, MAX_REQUEST_BYTES, NESSIE_API_BASE_URL,
};

const EXECUTOR: &str = "00000000-0000-4000-8000-000000000001";

fn pair_line(challenge: &str, workspace: &str) -> String {
    format!(
        r#"{{"command":"pair","apiBaseUrl":"{NESSIE_API_BASE_URL}","challenge":"{challenge}","enrollmentId":"{EXECUTOR}","workspaceRoot":"{workspace}"}}"#,
    )
}

fn pair_line_with_api(api: &str, challenge: &str, workspace: &str) -> String {
    format!(
        r#"{{"command":"pair","apiBaseUrl":"{api}","challenge":"{challenge}","enrollmentId":"{EXECUTOR}","workspaceRoot":"{workspace}"}}"#,
    )
}

fn absolute_workspace() -> &'static str {
    if cfg!(windows) {
        "C:\\\\Users\\\\person\\\\work"
    } else {
        "/home/person/work"
    }
}

#[test]
fn accepts_only_safe_executor_identifiers() {
    assert!(valid_identifier(EXECUTOR));
    for value in ["", "../state", "a/b", "a\\b", "a b", &"a".repeat(129)] {
        assert!(!valid_identifier(value), "identifier {value:?} must be refused");
    }
    assert_eq!(
        parse_request(r#"{"command":"start","executorId":"../state"}"#),
        Err("The team id is malformed.".to_owned()),
    );
}

#[test]
fn the_eight_companion_commands_are_the_whole_protocol() {
    assert_eq!(parse_request(r#"{"command":"status"}"#).unwrap(), Command::Status);
    assert_eq!(
        parse_request(r#"{"command":"enrollControlClient"}"#).unwrap(),
        Command::EnrollControlClient,
    );
    assert_eq!(
        parse_request(r#"{"command":"enrollControlClient","sid":"S-1-5-21-9"}"#),
        Err("The control request is malformed.".to_owned()),
    );
    assert_eq!(
        parse_request(&format!(r#"{{"command":"start","executorId":"{EXECUTOR}"}}"#)).unwrap(),
        Command::Start { executor_id: EXECUTOR.to_owned() },
    );
    assert_eq!(
        parse_request(&format!(r#"{{"command":"stop","executorId":"{EXECUTOR}"}}"#)).unwrap(),
        Command::Stop { executor_id: EXECUTOR.to_owned() },
    );
    assert_eq!(
        parse_request(&format!(r#"{{"command":"describe","executorId":"{EXECUTOR}"}}"#)).unwrap(),
        Command::Describe { executor_id: EXECUTOR.to_owned() },
    );
    assert_eq!(
        parse_request(&format!(r#"{{"command":"configureInput","executorId":"{EXECUTOR}","configurationInput":{{}}}}"#)).unwrap(),
        Command::ConfigureInput { executor_id: EXECUTOR.to_owned(), configuration_input: serde_json::json!({}) },
    );
    // An eighth command is not a command: nothing here falls back to `status`.
    for line in [
        r#"{"command":"uninstall"}"#,
        r#"{"command":"serve"}"#,
        r#"{}"#,
        "not json",
        "",
    ] {
        assert_eq!(
            parse_request(line),
            Err("The control request is malformed.".to_owned()),
            "line {line:?} must be refused",
        );
    }
}

#[test]
fn a_pairing_challenge_is_bounded_and_never_quoted_back() {
    let parsed = parse_request(&pair_line("challenge-value", absolute_workspace())).unwrap();
    let Command::Pair(command) = parsed else { panic!("a pair line must parse as pair") };
    assert_eq!(command.challenge, "challenge-value");
    for challenge in ["", &"c".repeat(8_193)] {
        let refusal = parse_request(&pair_line(challenge, absolute_workspace())).unwrap_err();
        assert_eq!(refusal, "The pairing challenge is malformed.");
        assert!(!refusal.contains(challenge) || challenge.is_empty());
    }
    // An oversized line is refused before it is parsed at all.
    assert_eq!(
        parse_request(&"x".repeat(MAX_REQUEST_BYTES + 1)),
        Err("The control request is malformed.".to_owned()),
    );
}

#[test]
fn pairing_accepts_self_hosted_https_and_refuses_everything_else() {
    let https = pair_line_with_api("https://api.example.test", "challenge-value", absolute_workspace());
    assert!(
        matches!(parse_request(&https).unwrap(), Command::Pair(_)),
        "a self-hosted HTTPS origin must be accepted",
    );
    let http = pair_line_with_api("http://api.example.test", "challenge-value", absolute_workspace());
    assert_eq!(
        parse_request(&http),
        Err("The server address must start with https://.".to_owned()),
    );
    let with_path = pair_line_with_api(
        "https://api.example.test/api.nessie.works",
        "challenge-value",
        absolute_workspace(),
    );
    assert_eq!(
        parse_request(&with_path),
        Err("Enter only the server address, without a page path or anything after it.".to_owned()),
    );
}

#[test]
fn every_build_accepts_both_spellings_of_the_local_development_api() {
    for api in LOOPBACK_API_BASE_URLS {
        let line = pair_line_with_api(api, "challenge-value", absolute_workspace());
        assert!(parse_request(&line).is_ok(), "{api} must be accepted");
    }
}

#[test]
fn pairing_requires_one_absolute_workspace_directory() {
    for workspace in ["", "work", "./work"] {
        assert_eq!(
            parse_request(&pair_line("challenge-value", workspace)),
            Err("Choose one existing absolute workspace directory.".to_owned()),
            "workspace {workspace:?} must be refused",
        );
    }
}

#[test]
fn canonicalizes_workspace_policy_without_browser_or_coding_operations() {
    assert_eq!(
        workspace_operation_keys(vec!["sandbox.stop".to_owned(), "file.read".to_owned()])
            .unwrap(),
        vec!["file.read", "sandbox.stop"],
    );
    assert!(workspace_operation_keys(vec!["browser.open".to_owned()]).is_err());
    assert!(workspace_operation_keys(Vec::new()).is_err());
    assert!(
        workspace_operation_keys(vec!["file.read".to_owned(), "file.read".to_owned()]).is_err()
    );
}

/// The response rule, asserted on the encoding rather than restated: every
/// variant declares its shape in the `status` tag.
#[test]
fn a_response_carries_executor_ids_and_states_and_nothing_else() {
    let encoded = Response::Ok {
        executors: vec![ExecutorStatus {
            daemon_status: "running".to_owned(),
            executor_id: EXECUTOR.to_owned(),
            workspace_configured: true,
            paused: true,
            failure: None,
            pending_program_requests: 2,
        }],
    }
    .encode();
    assert!(encoded.ends_with('\n'));
    assert_eq!(
        encoded.trim_end(),
        format!(
            r#"{{"status":"ok","executors":[{{"daemonStatus":"running","executorId":"{EXECUTOR}","workspaceConfigured":true,"paused":true,"pendingProgramRequests":2}}]}}"#,
        ),
    );
    let stopped = Response::Ok {
        executors: vec![ExecutorStatus {
            daemon_status: "stopped".to_owned(),
            executor_id: EXECUTOR.to_owned(),
            workspace_configured: true,
            paused: false,
            failure: Some(nessie_windows_common::failure::classify("Executor connection is fenced.")),
            pending_program_requests: 0,
        }],
    }
    .encode();
    assert!(stopped.contains(
        r#""failure":{"code":"EXECUTOR_CONNECTION_FENCED","message":"Executor connection is fenced."}"#
    ));
    let refusal = Response::error("This team is not connected on this computer.").encode();
    assert_eq!(
        refusal.trim_end(),
        r#"{"status":"error","reason":"This team is not connected on this computer."}"#,
    );
}

#[test]
fn a_pair_ok_response_carries_executor_id_and_fingerprint() {
    let encoded = Response::PairOk {
        executor_id: EXECUTOR.to_owned(),
        fingerprint: "abc123".to_owned(),
    }
    .encode();
    assert_eq!(
        encoded.trim_end(),
        format!(r#"{{"status":"pairOk","executorId":"{EXECUTOR}","fingerprint":"abc123"}}"#),
    );
}

#[test]
fn a_describe_response_carries_the_description_json() {
    let encoded = Response::DescribeOk {
        description: serde_json::json!({ "executorId": EXECUTOR }),
    }
    .encode();
    assert_eq!(
        encoded.trim_end(),
        format!(r#"{{"status":"describe","description":{{"executorId":"{EXECUTOR}"}}}}"#),
    );
}

#[test]
fn remove_names_one_validated_executor_and_nothing_else() {
    assert_eq!(
        parse_request(&format!(r#"{{"command":"remove","executorId":"{EXECUTOR}"}}"#)).unwrap(),
        Command::Remove { executor_id: EXECUTOR.to_owned() },
    );
    assert_eq!(
        parse_request(r#"{"command":"remove","executorId":"../executors"}"#),
        Err("The team id is malformed.".to_owned()),
    );
    // The state directory is derived from the id; a caller may not name one.
    for line in [
        r#"{"command":"remove"}"#,
        &format!(r#"{{"command":"remove","executorId":"{EXECUTOR}","stateDir":"C:\\\\elsewhere"}}"#),
    ] {
        assert_eq!(
            parse_request(line),
            Err("The control request is malformed.".to_owned()),
            "line {line:?} must be refused",
        );
    }
}

#[test]
fn a_removed_response_says_only_whether_the_sign_off_reached_nessie() {
    assert_eq!(
        Response::Removed { signed_off: true }.encode().trim_end(),
        r#"{"status":"removed","signedOff":true}"#,
    );
    assert_eq!(
        Response::Removed { signed_off: false }.encode().trim_end(),
        r#"{"status":"removed","signedOff":false}"#,
    );
}

#[test]
fn the_owner_controls_name_one_validated_team_and_one_known_answer() {
    assert_eq!(
        parse_request(&format!(r#"{{"command":"setPaused","executorId":"{EXECUTOR}","paused":true}}"#)).unwrap(),
        Command::SetPaused { executor_id: EXECUTOR.to_owned(), paused: true },
    );
    assert_eq!(
        parse_request(&format!(r#"{{"command":"programRequests","executorId":"{EXECUTOR}"}}"#)).unwrap(),
        Command::ProgramRequests { executor_id: EXECUTOR.to_owned() },
    );
    assert_eq!(
        parse_request(&format!(
            r#"{{"command":"answerProgramRequest","executorId":"{EXECUTOR}","id":"r-1","answer":"always"}}"#
        )).unwrap(),
        Command::AnswerProgramRequest {
            executor_id: EXECUTOR.to_owned(), id: "r-1".to_owned(),
            answer: nessie_windows_common::owner_controls::Answer::Always,
        },
    );
    for line in [
        format!(r#"{{"command":"setPaused","executorId":"{EXECUTOR}"}}"#),
        format!(r#"{{"command":"setPaused","executorId":"{EXECUTOR}","paused":"yes"}}"#),
        format!(r#"{{"command":"answerProgramRequest","executorId":"{EXECUTOR}","id":"../x","answer":"once"}}"#),
        format!(r#"{{"command":"answerProgramRequest","executorId":"{EXECUTOR}","id":"r-1","answer":"approve"}}"#),
        format!(r#"{{"command":"programRequests","executorId":"{EXECUTOR}","stateDir":"C:\\x"}}"#),
        format!(r#"{{"command":"audience","executorId":"{EXECUTOR}"}}"#),
    ] {
        assert!(parse_request(&line).is_err(), "line {line:?} must be refused");
    }
}

#[test]
fn the_sessions_commands_name_one_validated_team_and_one_session_uuid() {
    const SESSION: &str = "0b0c3a40-6f1e-4f7e-9d3b-2d1b8f1e4c11";
    assert_eq!(
        parse_request(&format!(r#"{{"command":"sessions","executorId":"{EXECUTOR}"}}"#)).unwrap(),
        Command::Sessions { executor_id: EXECUTOR.to_owned() },
    );
    assert_eq!(
        parse_request(&format!(r#"{{"command":"stopSession","executorId":"{EXECUTOR}","sessionId":"{SESSION}"}}"#))
            .unwrap(),
        Command::StopSession { executor_id: EXECUTOR.to_owned(), session_id: SESSION.to_owned() },
    );
    for line in [
        format!(r#"{{"command":"stopSession","executorId":"{EXECUTOR}","sessionId":"../x"}}"#),
        format!(r#"{{"command":"stopSession","executorId":"{EXECUTOR}"}}"#),
        format!(r#"{{"command":"sessions","executorId":"{EXECUTOR}","stateDir":"C:\\x"}}"#),
        format!(r#"{{"command":"stopSession","executorId":"../x","sessionId":"{SESSION}"}}"#),
    ] {
        assert!(parse_request(&line).is_err(), "line {line:?} must be refused");
    }
    assert_eq!(
        Response::Sessions { sessions: vec![serde_json::json!({ "sessionId": SESSION, "commands": [] })] }
            .encode().trim_end(),
        format!(r#"{{"status":"sessions","sessions":[{{"commands":[],"sessionId":"{SESSION}"}}]}}"#),
    );
}
