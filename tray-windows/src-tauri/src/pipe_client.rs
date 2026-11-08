//! Talking to the service over its control pipe, `\\.\pipe\NessieExecutor`,
//! through `nessie_windows_common::control_channel`: the same way in the
//! command line uses, so both prove the pipe is served by the signed service
//! before anything is written.
//!
//! One request line, one answer line, one connection. The tray keeps nothing
//! and decides nothing: the service owns the teams, their state, and every
//! refusal a person reads.
//!
//! Two Windows errors matter enough to translate, because they are the two a
//! person can actually act on: the pipe is missing when the service is not
//! running, and access is denied when this account has never been admitted —
//! which is what pairing's one elevated step exists to fix.

use crate::state::ExecutorStatus;
#[cfg(any(windows, test))]
use nessie_windows_common::control_channel::Unreachable;

pub const SERVICE_NOT_RUNNING: &str =
    "the service is not running — start Nessie Computer in Services";

pub const NOT_ADMITTED: &str =
    "this Windows account can’t use the Nessie Computer service yet — add this computer to a team to be admitted";

/// The useful answers the service can give, plus an error it already worded.
/// The tray never sees a path, a key, or a challenge unless it asked for a
/// describe, and even then the answer is the CLI's credential-free projection.
/// A removal answers only whether Nessie heard the connection sign off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceResponse {
    PersonalAttestation(serde_json::Value),
    InferenceConnections(serde_json::Value),
    Status(Vec<ExecutorStatus>),
    Pair { executor_id: String, fingerprint: String },
    Describe(serde_json::Value),
    Pairing(serde_json::Value),
    Removed { signed_off: bool },
    ProgramRequests(Vec<nessie_windows_common::owner_controls::ProgramRequest>),
    /// The sessions agents are working in for one team, as `sessions --json` printed them.
    Sessions(Vec<serde_json::Value>),
}

/// The sentence for a pipe that could not be used at all; the two a person
/// can act on are the ones `call` recognises when it merges the team lists.
#[cfg(any(windows, test))]
fn unreachable(reason: Unreachable) -> String {
    match reason {
        Unreachable::NotRunning => SERVICE_NOT_RUNNING,
        Unreachable::NotAdmitted => NOT_ADMITTED,
        Unreachable::NotTrusted => "something other than the signed Nessie Computer service is answering its pipe",
        Unreachable::Busy => "the service is busy — try again in a moment",
        Unreachable::Failed => "the service could not be reached",
    }
    .to_owned()
}

/// Sends one request and returns the answer it was given. A refusal comes
/// back as the service's own words, never as a status code the tray would
/// have to invent a sentence for.
#[cfg(windows)]
fn service_call(request: &serde_json::Value) -> Result<ServiceResponse, String> {
    let mut line = serde_json::to_string(request)
        .map_err(|_| "the control request could not be prepared".to_owned())?;
    line.push('\n');
    let answer = nessie_windows_common::control_channel::call(&line, crate::service_peer::PIN).map_err(unreachable)?;
    decode(&answer)
}

/// Personal delegation always reaches the service; it never borrows the
/// user-session CLI's independent machine key or falls back after a refusal.
pub(crate) fn personal_attestation(request: &serde_json::Value) -> Result<serde_json::Value, String> {
    match service_call(request)? {
        ServiceResponse::PersonalAttestation(authority) => Ok(authority),
        _ => Err("The service returned no personal delegation authority.".into()),
    }
}

/// The pipe is a Windows object; on any other host the service is simply not
/// there to answer, and the view says so in the words it would use for a
/// stopped service.
#[cfg(not(windows))]
fn service_call(request: &serde_json::Value) -> Result<ServiceResponse, String> {
    let _ = request;
    Err(SERVICE_NOT_RUNNING.to_owned())
}

pub(crate) fn service_control(request: &serde_json::Value) -> Result<ServiceResponse, String> {
    service_call(request)
}

fn local_route(command: &str, owned: Option<bool>) -> bool {
    owned == Some(true) || (owned.is_none() && matches!(command,
        "pairingStart" | "pairingStatus" | "pairingCancel"))
}

/// Add this computer runs under this account; a ChatGPT plan connection
/// addresses service_control explicitly, without fallback.
pub fn call(request: &serde_json::Value) -> Result<ServiceResponse, String> {
    let command = request["command"].as_str().unwrap_or("");
    if command == "status" {
        let ServiceResponse::Status(mut executors) = crate::user_connections::call(request)? else {
            return Err("Could not list local teams.".into());
        };
        match service_call(request) {
            Ok(ServiceResponse::Status(service)) => executors.extend(service),
            Err(reason) if reason == SERVICE_NOT_RUNNING || reason == NOT_ADMITTED => {}
            Err(reason) => return Err(reason),
            _ => return Err("The service returned an invalid team list.".into()),
        }
        return Ok(ServiceResponse::Status(executors));
    }
    let local = request["executorId"].as_str().map(crate::user_connections::owns);
    if local_route(command, local) {
        crate::user_connections::call(request)
    } else { service_call(request) }
}

/// The recognised answer shapes, and nothing else: an answer this reader does
/// not recognise is a failure, never an empty executor list.
fn decode(answer: &str) -> Result<ServiceResponse, String> {
    let parsed: serde_json::Value = serde_json::from_str(answer.trim())
        .map_err(|_| "Nessie Computer couldn’t understand its service’s reply. Try again, or restart Nessie Computer.".to_owned())?;
    match parsed.get("status").and_then(serde_json::Value::as_str) {
        Some("inferenceConnections") => parsed.get("connections").cloned().map(ServiceResponse::InferenceConnections)
            .ok_or_else(|| "No inference connections were returned.".to_owned()),
        Some("personalAttestation") => parsed.get("authority").cloned().map(ServiceResponse::PersonalAttestation)
            .ok_or_else(|| "The service returned no personal authority.".to_owned()),
        Some("pairing") => parsed.get("pairing").cloned().map(ServiceResponse::Pairing)
            .ok_or_else(|| "Pairing returned no answer.".to_owned()),
        Some("programRequests") => parsed.get("requests").cloned()
            .ok_or_else(|| "The program requests could not be read.".to_owned())
            .and_then(nessie_windows_common::owner_controls::parse_program_requests)
            .map(ServiceResponse::ProgramRequests),
        Some("sessions") => parsed.get("sessions").cloned()
            .ok_or_else(|| "The list of what agents are doing could not be read.".to_owned())
            .and_then(nessie_windows_common::owner_sessions::parse_sessions)
            .map(ServiceResponse::Sessions),
        Some("ok") => {
            let executors = serde_json::from_value(
                parsed.get("executors").cloned().unwrap_or(serde_json::Value::Null),
            )
            .map_err(|_| "Nessie Computer couldn’t understand its service’s reply. Try again, or restart Nessie Computer.".to_owned())?;
            Ok(ServiceResponse::Status(executors))
        }
        Some("pairOk") => {
            let executor_id = parsed
                .get("executorId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "Nessie Computer couldn’t understand its service’s reply. Try again, or restart Nessie Computer.".to_owned())?
                .to_owned();
            let fingerprint = parsed
                .get("fingerprint")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "Nessie Computer couldn’t understand its service’s reply. Try again, or restart Nessie Computer.".to_owned())?
                .to_owned();
            Ok(ServiceResponse::Pair { executor_id, fingerprint })
        }
        Some("describe") => {
            let description = parsed
                .get("description")
                .cloned()
                .ok_or_else(|| "Nessie Computer couldn’t understand its service’s reply. Try again, or restart Nessie Computer.".to_owned())?;
            Ok(ServiceResponse::Describe(description))
        }
        Some("removed") => parsed
            .get("signedOff")
            .and_then(serde_json::Value::as_bool)
            .map(|signed_off| ServiceResponse::Removed { signed_off })
            .ok_or_else(|| "Nessie Computer couldn’t understand its service’s reply. Try again, or restart Nessie Computer.".to_owned()),
        Some("error") => Err(parsed
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("the service refused the request")
            .to_owned()),
        _ => Err("Nessie Computer couldn’t understand its service’s reply. Try again, or restart Nessie Computer.".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::{decode, unreachable, ServiceResponse, NOT_ADMITTED, SERVICE_NOT_RUNNING};
    use nessie_windows_common::control_channel::{read_answer, Unreachable};

    /// What `service_call` does with the bytes the pipe returns.
    fn read_one_response(reader: impl std::io::Read) -> Result<ServiceResponse, String> {
        decode(&read_answer(reader).map_err(unreachable)?)
    }

    #[test]
    fn an_ok_answer_carries_the_executor_list_verbatim() {
        let response = decode(
            r#"{"status":"ok","executors":[{"daemonStatus":"running","executorId":"a-1","workspaceConfigured":true,"paused":true,"pendingProgramRequests":1}]}"#,
        )
        .expect("an ok answer must decode");
        let ServiceResponse::Status(executors) = response else { panic!("expected status response") };
        assert_eq!(executors.len(), 1);
        assert_eq!(executors[0].daemon_status, "running");
        assert_eq!(executors[0].executor_id, "a-1");
        assert!(executors[0].paused);
        assert_eq!(executors[0].pending_program_requests, 1);
        assert_eq!(executors[0].connection, crate::state::Connection::Service);
    }

    #[test]
    fn program_requests_and_sessions_answers_decode_strictly() {
        let requests = decode(r#"{"status":"programRequests","requests":[{"id":"r1","program":"python","args":[],"requestedAt":"2026-11-08T10:00:00.000Z","expiresAt":"2026-11-08T10:02:00.000Z"}]}"#)
            .expect("a request list must decode");
        let ServiceResponse::ProgramRequests(list) = requests else { panic!("expected requests") };
        assert_eq!(list[0].program, "python");
        assert!(decode(r#"{"status":"programRequests"}"#).is_err());
        assert!(decode(r#"{"status":"programRequests","requests":{}}"#).is_err());
        let sessions = decode(r#"{"status":"sessions","sessions":[{"sessionId":"0b0c3a40-6f1e-4f7e-9d3b-2d1b8f1e4c11","commands":[]}]}"#)
            .unwrap();
        let ServiceResponse::Sessions(list) = sessions else { panic!("expected sessions") };
        assert_eq!(list.len(), 1);
        assert!(decode(r#"{"status":"sessions","sessions":{}}"#).is_err());
        assert!(decode(r#"{"status":"sessions"}"#).is_err());
        assert!(decode(r#"{"status":"audience","audience":{"agents":[]}}"#).is_err());
    }

    #[test]
    fn a_pair_ok_answer_carries_executor_id_and_fingerprint() {
        let response = decode(
            r#"{"status":"pairOk","executorId":"a-1","fingerprint":"abc123"}"#,
        )
        .expect("pair answer must decode");
        assert_eq!(
            response,
            ServiceResponse::Pair {
                executor_id: "a-1".to_owned(),
                fingerprint: "abc123".to_owned(),
            }
        );
    }

    #[test]
    fn a_describe_answer_carries_the_description_json() {
        let response = decode(r#"{"status":"describe","description":{"executorId":"a-1"}}"#)
            .expect("describe answer must decode");
        let ServiceResponse::Describe(description) = response else { panic!("expected describe response") };
        assert_eq!(description["executorId"], "a-1");
    }

    #[test]
    fn a_removed_answer_carries_only_whether_the_sign_off_reached_nessie() {
        assert_eq!(
            decode(r#"{"status":"removed","signedOff":true}"#),
            Ok(ServiceResponse::Removed { signed_off: true }),
        );
        assert_eq!(
            decode(r#"{"status":"removed","signedOff":false}"#),
            Ok(ServiceResponse::Removed { signed_off: false }),
        );
        for answer in [r#"{"status":"removed"}"#, r#"{"status":"removed","signedOff":"true"}"#] {
            assert!(decode(answer).is_err(), "answer {answer:?} must be a failure");
        }
    }

    #[test]
    fn a_refusal_reaches_the_person_in_the_services_own_words() {
        assert_eq!(
            decode(r#"{"status":"error","reason":"This team is not connected on this computer."}"#),
            Err("This team is not connected on this computer.".to_owned()),
        );
    }

    /// The failure mode worth naming: an unrecognised answer must not read as
    /// "no executors are paired", which would look exactly like a healthy
    /// machine with nothing set up.
    #[test]
    fn an_unrecognised_answer_is_a_failure_and_not_an_empty_list() {
        for answer in ["", "not json", "{}", r#"{"status":"maybe"}"#, r#"{"status":"ok","executors":3}"#] {
            assert!(decode(answer).is_err(), "answer {answer:?} must be a failure");
        }
    }

    #[test]
    fn a_complete_line_is_enough_without_waiting_for_eof() {
        let response = read_one_response(&b"{\"status\":\"ok\",\"executors\":[]}\nignored"[..])
            .expect("the first framed response is complete");
        assert_eq!(response, ServiceResponse::Status(Vec::new()));
    }

    #[test]
    fn an_unterminated_or_oversized_response_is_refused() {
        assert!(read_one_response(&b"{\"status\":\"ok\",\"executors\":[]}"[..]).is_err());
        let limit = nessie_windows_common::control_channel::MAX_ANSWER_BYTES as usize;
        let oversized = format!("{}\n", "x".repeat(limit));
        assert!(read_one_response(oversized.as_bytes()).is_err());
    }

    #[test]
    fn the_two_reasons_a_person_can_act_on_keep_their_own_words() {
        // `call` lists this account's own teams when the service is missing or
        // has not admitted this account; it recognises those two by these words.
        assert_eq!(unreachable(Unreachable::NotRunning), SERVICE_NOT_RUNNING);
        assert_eq!(unreachable(Unreachable::NotAdmitted), NOT_ADMITTED);
        for reason in [Unreachable::NotTrusted, Unreachable::Busy, Unreachable::Failed] {
            assert!(![SERVICE_NOT_RUNNING, NOT_ADMITTED].contains(&unreachable(reason).as_str()));
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_named_pipe_disconnect_after_a_complete_response_is_not_a_client_failure() {
        use std::{
            io::Write,
            os::windows::{ffi::OsStrExt, io::FromRawHandle},
        };
        use windows_sys::Win32::{
            Foundation::{GetLastError, ERROR_PIPE_CONNECTED, GENERIC_READ, INVALID_HANDLE_VALUE},
            Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING, PIPE_ACCESS_DUPLEX},
            System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT},
        };

        fn wide(value: &str) -> Vec<u16> {
            std::ffi::OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
        }

        let name = format!(r"\\.\pipe\NessieExecutor-reader-test-{}", std::process::id());
        let server = unsafe {
            CreateNamedPipeW(
                wide(&name).as_ptr(), PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1, 1_024, 1_024, 0, std::ptr::null(),
            )
        };
        assert_ne!(server, INVALID_HANDLE_VALUE, "the test pipe must be creatable");
        let server = server as usize;
        let server_thread = std::thread::spawn(move || {
            let server = server as windows_sys::Win32::Foundation::HANDLE;
            let connected = unsafe { ConnectNamedPipe(server, std::ptr::null_mut()) } != 0
                || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
            assert!(connected, "the client must connect to the test pipe");
            let mut file = unsafe { std::fs::File::from_raw_handle(server as *mut _) };
            file.write_all(b"{\"status\":\"ok\",\"executors\":[]}\n")
                .expect("the server writes its complete response");
            file.flush().expect("the server flushes its complete response");
            // Dropping the server immediately is the production close shape
            // that previously made `read_to_string` report a false failure.
        });
        let client = unsafe {
            CreateFileW(
                wide(&name).as_ptr(), GENERIC_READ, 0, std::ptr::null(), OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL, std::ptr::null_mut(),
            )
        };
        assert_ne!(client, INVALID_HANDLE_VALUE, "the test client must connect");
        let client_file = unsafe { std::fs::File::from_raw_handle(client as *mut _) };
        assert_eq!(
            read_one_response(&client_file).expect("the line is valid before disconnect"),
            ServiceResponse::Status(Vec::new()),
        );
        drop(client_file);
        server_thread.join().expect("the server must finish");
    }
}
