//! Talking to the service over `\\.\pipe\NessieExecutor`.
//!
//! One request line, one answer line, one connection. The tray keeps nothing
//! and decides nothing: the service owns the executors, their state, and every
//! refusal a person reads.
//!
//! Two Windows errors matter enough to translate, because they are the two a
//! person can actually act on: the pipe is missing when the service is not
//! running, and access is denied when this account has never been admitted —
//! which is what pairing's one elevated step exists to fix.
//!
//! The protocol's answer shapes are portable and tested on any host; the pipe
//! itself lives behind `cfg(windows)` in [`imp`].

use crate::state::ExecutorStatus;
use std::io::{BufRead, BufReader, Read};

/// Bounded so a service answering nonsense cannot exhaust this process.
const MAX_ANSWER_BYTES: u64 = 1_048_576;

pub const SERVICE_NOT_RUNNING: &str =
    "the service is not running — start Nessie Executor in Services";

pub const NOT_ADMITTED: &str =
    "this account may not control the executor — pair one from this tray to be admitted";

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
}

/// Reads one complete line from a pipe response. A named-pipe server may close
/// immediately after writing: Windows reports that as `ERROR_BROKEN_PIPE`, not
/// end-of-file, so reading until EOF turns a valid answer into a false refusal.
/// The protocol is one newline-framed JSON answer, and a missing terminator is
/// incomplete even when its bytes happen to parse as JSON.
fn read_one_response(reader: impl Read) -> Result<ServiceResponse, String> {
    let mut answer = String::new();
    let mut bounded = BufReader::new(reader.take(MAX_ANSWER_BYTES));
    bounded
        .read_line(&mut answer)
        .map_err(|_| "the service closed the connection".to_owned())?;
    if !answer.ends_with('\n') {
        return Err("the service closed the connection".to_owned());
    }
    decode(&answer)
}

#[cfg(windows)]
mod imp {
    use std::{
        io::Write,
        mem::ManuallyDrop,
        os::windows::{ffi::OsStrExt, io::FromRawHandle},
    };

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY,
        HANDLE, INVALID_HANDLE_VALUE,
    };
    use nessie_windows_common::CONTROL_PIPE_CLIENT_ACCESS;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

    use super::{read_one_response, NOT_ADMITTED, SERVICE_NOT_RUNNING};

    const PIPE_NAME: &str = r"\\.\pipe\NessieExecutor";

    /// How long to wait for a free instance, and how many times. The service
    /// serves each connection on its own thread, so a busy pipe is a burst, not
    /// a queue.
    const BUSY_WAIT_MS: u32 = 2_000;

    const BUSY_ATTEMPTS: u32 = 3;

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
    }

    fn open() -> Result<HANDLE, String> {
        let name = wide(PIPE_NAME);
        for _ in 0..BUSY_ATTEMPTS {
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    CONTROL_PIPE_CLIENT_ACCESS,
                    0,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    std::ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE && !handle.is_null() {
                return Ok(handle);
            }
            match unsafe { GetLastError() } {
                ERROR_PIPE_BUSY => {
                    unsafe { WaitNamedPipeW(name.as_ptr(), BUSY_WAIT_MS) };
                }
                ERROR_FILE_NOT_FOUND => return Err(SERVICE_NOT_RUNNING.to_owned()),
                ERROR_ACCESS_DENIED => return Err(NOT_ADMITTED.to_owned()),
                _ => return Err("the service could not be reached".to_owned()),
            }
        }
        Err("the service is busy — try again in a moment".to_owned())
    }

    /// Sends one request and returns the answer it was given. A refusal comes
    /// back as the service's own words, never as a status code the tray would
    /// have to invent a sentence for.
    pub fn call(request: &serde_json::Value) -> Result<super::ServiceResponse, String> {
        let handle = open()?;
        if let Err(error) = crate::service_peer::verify(handle) {
            unsafe { CloseHandle(handle) };
            return Err(error);
        }
        let file = ManuallyDrop::new(unsafe { std::fs::File::from_raw_handle(handle as *mut _) });
        let mut line = serde_json::to_string(request)
            .map_err(|_| "the control request could not be prepared".to_owned())?;
        line.push('\n');
        let wrote = (&*file).write_all(line.as_bytes()).and_then(|()| (&*file).flush());
        let response = if wrote.is_ok() {
            read_one_response(&*file)
        } else {
            Err("the service closed the connection".to_owned())
        };
        unsafe { CloseHandle(handle) };
        response
    }
}

#[cfg(windows)]
use imp::call as service_call;

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

/// Ordinary Add team remains interactive for the owner's installed tools.
/// Personal-plan pairing addresses service_control explicitly, without fallback.
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
        .map_err(|_| "Nessie Executor couldn’t understand its service’s reply. Try again, or restart Nessie Executor.".to_owned())?;
    match parsed.get("status").and_then(serde_json::Value::as_str) {
        Some("inferenceConnections") => parsed.get("connections").cloned().map(ServiceResponse::InferenceConnections)
            .ok_or_else(|| "No inference connections were returned.".to_owned()),
        Some("personalAttestation") => parsed.get("authority").cloned().map(ServiceResponse::PersonalAttestation)
            .ok_or_else(|| "The service returned no personal authority.".to_owned()),
        Some("pairing") => parsed.get("pairing").cloned().map(ServiceResponse::Pairing)
            .ok_or_else(|| "Pairing returned no answer.".to_owned()),
        Some("ok") => {
            let executors = serde_json::from_value(
                parsed.get("executors").cloned().unwrap_or(serde_json::Value::Null),
            )
            .map_err(|_| "Nessie Executor couldn’t understand its service’s reply. Try again, or restart Nessie Executor.".to_owned())?;
            Ok(ServiceResponse::Status(executors))
        }
        Some("pairOk") => {
            let executor_id = parsed
                .get("executorId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "Nessie Executor couldn’t understand its service’s reply. Try again, or restart Nessie Executor.".to_owned())?
                .to_owned();
            let fingerprint = parsed
                .get("fingerprint")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "Nessie Executor couldn’t understand its service’s reply. Try again, or restart Nessie Executor.".to_owned())?
                .to_owned();
            Ok(ServiceResponse::Pair { executor_id, fingerprint })
        }
        Some("describe") => {
            let description = parsed
                .get("description")
                .cloned()
                .ok_or_else(|| "Nessie Executor couldn’t understand its service’s reply. Try again, or restart Nessie Executor.".to_owned())?;
            Ok(ServiceResponse::Describe(description))
        }
        Some("removed") => parsed
            .get("signedOff")
            .and_then(serde_json::Value::as_bool)
            .map(|signed_off| ServiceResponse::Removed { signed_off })
            .ok_or_else(|| "Nessie Executor couldn’t understand its service’s reply. Try again, or restart Nessie Executor.".to_owned()),
        Some("error") => Err(parsed
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("the service refused the request")
            .to_owned()),
        _ => Err("Nessie Executor couldn’t understand its service’s reply. Try again, or restart Nessie Executor.".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::{decode, read_one_response, ServiceResponse};

    #[test]
    fn an_ok_answer_carries_the_executor_list_verbatim() {
        let response = decode(
            r#"{"status":"ok","executors":[{"daemonStatus":"running","executorId":"a-1","workspaceConfigured":true}]}"#,
        )
        .expect("an ok answer must decode");
        let ServiceResponse::Status(executors) = response else { panic!("expected status response") };
        assert_eq!(executors.len(), 1);
        assert_eq!(executors[0].daemon_status, "running");
        assert_eq!(executors[0].executor_id, "a-1");
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
            decode(r#"{"status":"error","reason":"This executor has not been paired on this computer."}"#),
            Err("This executor has not been paired on this computer.".to_owned()),
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
        let oversized = format!("{}\n", "x".repeat(super::MAX_ANSWER_BYTES as usize));
        assert!(read_one_response(oversized.as_bytes()).is_err());
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
