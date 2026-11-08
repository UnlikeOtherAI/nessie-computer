//! One accepted control request, carried out.
//!
//! This is the seam between the pipe (which decides *who* is asking) and the
//! supervisor (which decides *what happens*). Every answer is the full executor
//! list, so the tray refreshes in the same round trip that changed something and
//! never renders a state it inferred rather than read.
//!
//! It is deliberately platform-neutral: the two refusals a person is most likely
//! to meet — an executor this computer has not paired, and a malformed id — are
//! decided here and tested on any host.

use std::{path::PathBuf, sync::Mutex};

use crate::{
    helper::secure_directory,
    protocol::{Command, Response},
    supervisor::Supervisor,
};

/// Whether this service may supervise anything, and why not when it may not.
///
/// A service that could not verify its own release or its packaged runtime keeps
/// **running** and refuses every command in words. Stopping instead would leave
/// a person with a service that is not there and no explanation anywhere: the
/// tray would show only "the service is not running", which is the wrong
/// diagnosis for a tampered runtime and names the wrong remedy.
pub enum Control {
    Refused(String),
    Supervising(Mutex<Supervisor>),
}

impl Control {
    pub fn new(supervisor: Supervisor) -> Self {
        Self::Supervising(Mutex::new(supervisor))
    }

    pub fn supervisor(&self) -> Option<&Mutex<Supervisor>> {
        match self {
            Self::Refused(_) => None,
            Self::Supervising(supervisor) => Some(supervisor),
        }
    }

    /// `client_sid` is the account the pipe read off the connection. It is
    /// recorded when a pairing succeeds, which is what admits that person's
    /// later, unelevated calls.
    pub fn handle(&self, command: Command, client_sid: Option<&str>) -> Response {
        let supervisor = match self {
            Self::Refused(reason) => return Response::error(reason.clone()),
            Self::Supervising(supervisor) => supervisor,
        };
        let Ok(mut supervisor) = supervisor.lock() else {
            return Response::error("The Nessie Computer service is not available.");
        };
        match command {
            // The pipe owns this command and independently observes its process.
            Command::ManagedCustody { .. } => Response::error("The control request is malformed."),
            Command::PersonalAttestation {
                executor_id,
                operation,
            } => match supervisor.personal_attestation(&executor_id, operation, client_sid) {
                Ok(authority) => Response::PersonalAttestation { authority },
                Err(reason) => Response::error(reason),
            },
            Command::PairingStart {
                api_base_url,
                workspace_root,
                replace,
            } => {
                match supervisor.pairing_start(&api_base_url, &workspace_root, replace, client_sid)
                {
                    Ok(pairing) => Response::Pairing { pairing },
                    Err(reason) => Response::error(reason),
                }
            }
            Command::PairingStatus { executor_id } => match executor_id {
                Some(id) => match supervisor.pairing_connection(&id) {
                    Ok(pairing) => Response::Pairing { pairing },
                    Err(reason) => Response::error(reason),
                },
                None => match supervisor.pairing_action("status", None, client_sid) {
                    Ok(pairing) => Response::Pairing { pairing },
                    Err(reason) => Response::error(reason),
                },
            },
            Command::PairingCancel => match supervisor.pairing_action("cancel", None, client_sid) {
                Ok(pairing) => Response::Pairing { pairing },
                Err(reason) => Response::error(reason),
            },
            Command::PairingConfirm { claim_digest } => {
                match supervisor.pairing_action("confirm", Some(&claim_digest), client_sid) {
                    Ok(pairing) => Response::Pairing { pairing },
                    Err(reason) => Response::error(reason),
                }
            }
            // The pipe owns this command because it alone has the
            // impersonated Windows token needed to authenticate the SID.
            Command::EnrollControlClient => Response::error("The control request is malformed."),
            Command::Status => match supervisor.statuses() {
                executors => Response::Ok { executors },
            },
            Command::Start { executor_id } => match supervisor.start(&executor_id) {
                Ok(_) => Response::Ok {
                    executors: supervisor.statuses(),
                },
                Err(reason) => Response::error(reason),
            },
            Command::Stop { executor_id } => match supervisor.stop(&executor_id) {
                Ok(_) => Response::Ok {
                    executors: supervisor.statuses(),
                },
                Err(reason) => Response::error(reason),
            },
            Command::SetPaused { executor_id, paused } => match supervisor.set_paused(&executor_id, paused) {
                Ok(()) => Response::Ok {
                    executors: supervisor.statuses(),
                },
                Err(reason) => Response::error(reason),
            },
            Command::ProgramRequests { executor_id } => {
                match supervisor.program_requests(&executor_id, client_sid) {
                    Ok(requests) => Response::ProgramRequests { requests },
                    Err(reason) => Response::error(reason),
                }
            }
            Command::AnswerProgramRequest { executor_id, id, answer } => {
                match supervisor.answer_program_request(&executor_id, &id, answer, client_sid) {
                    Ok(requests) => Response::ProgramRequests { requests },
                    Err(reason) => Response::error(reason),
                }
            }
            Command::Sessions { executor_id } => match supervisor.sessions(&executor_id, client_sid) {
                Ok(sessions) => Response::Sessions { sessions },
                Err(reason) => Response::error(reason),
            },
            Command::StopSession { executor_id, session_id } => {
                match supervisor.stop_session(&executor_id, &session_id, client_sid) {
                    Ok(sessions) => Response::Sessions { sessions },
                    Err(reason) => Response::error(reason),
                }
            }
            Command::Audience { executor_id } => match supervisor.audience(&executor_id) {
                Ok(audience) => Response::Audience { audience },
                Err(reason) => Response::error(reason),
            },
            Command::Remove { executor_id } => match supervisor.remove(&executor_id, client_sid) {
                Ok(signed_off) => Response::Removed { signed_off },
                Err(reason) => Response::error(reason),
            },
            Command::Configure {
                executor_id,
                operation_keys,
            } => match supervisor.configure(&executor_id, &operation_keys) {
                Ok(_) => Response::Ok {
                    executors: supervisor.statuses(),
                },
                Err(reason) => Response::error(reason),
            },
            Command::ConfigureInput {
                executor_id,
                configuration_input,
            } => match supervisor.configure_input(&executor_id, configuration_input) {
                Ok(_) => Response::Ok {
                    executors: supervisor.statuses(),
                },
                Err(reason) => Response::error(reason),
            },
            Command::InferenceConnections { executor_id, operation } => {
                match supervisor.inference_connections(&executor_id, operation, client_sid) {
                    Ok(connections) => Response::InferenceConnections { connections },
                    Err(reason) => Response::error(reason),
                }
            }
            Command::Describe { executor_id } => match supervisor.describe(&executor_id) {
                Ok(description) => Response::DescribeOk { description },
                Err(reason) => Response::error(reason),
            },
            Command::Pair(pair) => {
                let helper: PathBuf = supervisor.runtime().native_helper.clone();
                match supervisor.pair(&pair, client_sid, move |path| {
                    secure_directory(&helper, path)
                }) {
                    Ok((executor_id, fingerprint)) => Response::PairOk {
                        executor_id,
                        fingerprint,
                    },
                    Err(reason) => Response::error(reason),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Control;
    use crate::{
        manifest::VerifiedRuntime,
        protocol::{Command, Response},
        supervisor::Supervisor,
    };

    /// A runtime that names files which do not exist. Every test below refuses
    /// before anything would be executed, which is the point being asserted.
    fn control(root: &std::path::Path) -> Control {
        Control::new(Supervisor::new(
            root.to_path_buf(),
            VerifiedRuntime {
                native_helper: root.join("nessie-executor-native.exe"),
                node_executable: root.join("nessie-executor-runtime.exe"),
                root: root.to_path_buf(),
            },
        ))
    }

    #[test]
    fn a_computer_with_nothing_paired_answers_with_an_empty_list() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        assert_eq!(
            control(directory.path()).handle(Command::Status, None),
            Response::Ok {
                executors: Vec::new()
            },
        );
    }

    /// Starting an executor this computer has never paired must refuse in words
    /// rather than spawn the packaged CLI to find out.
    #[test]
    fn starting_an_unpaired_executor_is_refused_before_anything_runs() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        assert_eq!(
            control(directory.path()).handle(
                Command::Start {
                    executor_id: "00000000-0000-4000-8000-000000000001".to_owned()
                },
                None,
            ),
            Response::error("This team is not connected on this computer."),
        );
    }

    /// Removing refuses in words before anything runs: an unpaired id never
    /// spawns the packaged CLI, and nothing on disk changes.
    #[test]
    fn removing_an_unpaired_executor_is_refused_before_anything_runs() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        assert_eq!(
            control(directory.path()).handle(
                Command::Remove {
                    executor_id: "00000000-0000-4000-8000-000000000001".to_owned()
                },
                None,
            ),
            Response::error("This team is not connected on this computer."),
        );
        assert!(!directory.path().join("executors").exists());
    }

    #[test]
    fn stopping_something_that_is_not_running_is_not_an_error() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        assert_eq!(
            control(directory.path()).handle(
                Command::Stop {
                    executor_id: "00000000-0000-4000-8000-000000000001".to_owned()
                },
                None,
            ),
            Response::Ok {
                executors: Vec::new()
            },
        );
    }

    /// A service that refused to supervise still answers, and answers with the
    /// reason. The tray turns red and says why; a service that had stopped
    /// instead would have the tray reporting the wrong problem entirely.
    #[test]
    fn a_refusing_service_answers_every_command_with_its_reason() {
        let refusal = "Executor controls require a signed, intact Nessie release.";
        let control = Control::Refused(refusal.to_owned());
        for command in [
            Command::Status,
            Command::PairingStatus { executor_id: None },
            Command::PairingCancel,
            Command::PairingConfirm {
                claim_digest: format!("sha256:{}", "0".repeat(64)),
            },
            Command::Start {
                executor_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            },
            Command::Stop {
                executor_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            },
            Command::Remove {
                executor_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            },
        ] {
            assert_eq!(control.handle(command, None), Response::error(refusal));
        }
        assert!(control.supervisor().is_none());
    }
}
