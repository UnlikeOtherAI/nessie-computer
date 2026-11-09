//! The named-pipe control protocol: one JSON object per line, in and out.
//!
//! The tray is a stateless client of the CLI, so the protocol exposes the
//! commands it needs: `status`, `pair`, `start`, `stop`, `describe`,
//! `configureInput`, `remove`, and the owner's own controls — `setPaused`,
//! `programRequests`, `answerProgramRequest`, `sessions` and `stopSession`.
//! `describe`
//! returns the same credential-free JSON the CLI prints; `configureInput` carries the whole stdin payload for
//! `configure --configuration-input-stdin`; `remove` runs the CLI's `unpair`
//! and answers only whether Nessie heard the sign-off. This keeps the tray from
//! ever opening `executor-state.json` while still letting it show folders,
//! origins, and permitted commands.
//!
//! Everything here is a pure function of the request text, so both halves of the
//! contract are tested on any host.

use nessie_windows_common::{failure::Failure, owner_controls::Answer, team_label::TeamLabel};
use serde::{Deserialize, Serialize};

pub use crate::protocol_values::MAX_REQUEST_BYTES;
use crate::protocol_values::{
    approved_api_base_url, challenge, workspace_operation_keys, workspace_root, MAX_IDENTIFIER_BYTES,
};
#[cfg(test)]
use crate::protocol_values::{LOOPBACK_API_BASE_URLS, NESSIE_API_BASE_URL};

/// A validated command. Construction is the validation: nothing downstream
/// re-checks these, and nothing downstream may skip them.
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    ManagedCustody {
        operation: nessie_windows_common::custody::Operation,
    },
    PersonalAttestation {
        executor_id: String,
        operation: crate::service_chatgpt::Operation,
    },
    Configure {
        executor_id: String,
        operation_keys: Vec<String>,
    },
    ConfigureInput {
        executor_id: String,
        configuration_input: serde_json::Value,
    },
    Describe {
        executor_id: String,
    },
    InferenceConnections {
        executor_id: String,
        operation: serde_json::Value,
    },
    EnrollControlClient,
    Pair(PairCommand),
    PairingStart {
        api_base_url: String,
        workspace_root: String,
        replace: bool,
    },
    PairingStatus {
        executor_id: Option<String>,
    },
    PairingConfirm {
        claim_digest: String,
    },
    PairingCancel,
    Remove {
        executor_id: String,
    },
    SetPaused {
        executor_id: String,
        paused: bool,
    },
    ProgramRequests {
        executor_id: String,
    },
    AnswerProgramRequest {
        executor_id: String,
        id: String,
        answer: Answer,
    },
    Sessions {
        executor_id: String,
    },
    StopSession {
        executor_id: String,
        session_id: String,
    },
    Start {
        executor_id: String,
    },
    Status,
    Stop {
        executor_id: String,
    },
}

#[derive(Debug, PartialEq, Eq)]
/// The executor id is deliberately absent: the API assigns it and returns it in
/// the pairing reply, so the service stages the pairing under the enrollment id
/// and names the state directory only once the state file names an executor.
pub struct PairCommand {
    pub api_base_url: String,
    pub challenge: String,
    pub enrollment_id: String,
    pub workspace_root: String,
}

/// The wire shape. Serde rejects an unknown command outright rather than
/// defaulting to one, and every field is validated after parsing.
/// `rename_all` names the commands; `rename_all_fields` names their arguments —
/// both are needed, because the first alone leaves the fields in snake case and
/// every request would parse as malformed.
#[derive(Deserialize)]
#[serde(
    deny_unknown_fields,
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "command"
)]
enum Request {
    ManagedCustody {
        operation: nessie_windows_common::custody::Operation,
    },
    PersonalAttestation {
        executor_id: String,
        operation: serde_json::Value,
    },
    Configure {
        executor_id: String,
        operation_keys: Vec<String>,
    },
    ConfigureInput {
        executor_id: String,
        configuration_input: serde_json::Value,
    },
    Describe {
        executor_id: String,
    },
    InferenceConnections {
        executor_id: String,
        operation: serde_json::Value,
    },
    EnrollControlClient {},
    Pair {
        api_base_url: String,
        challenge: String,
        enrollment_id: String,
        workspace_root: String,
    },
    PairingStart {
        api_base_url: String,
        workspace_root: String,
        replace: bool,
    },
    PairingStatus {
        executor_id: Option<String>,
    },
    PairingConfirm {
        claim_digest: String,
    },
    PairingCancel,
    Remove {
        executor_id: String,
    },
    SetPaused {
        executor_id: String,
        paused: bool,
    },
    ProgramRequests {
        executor_id: String,
    },
    AnswerProgramRequest {
        executor_id: String,
        id: String,
        answer: String,
    },
    Sessions {
        executor_id: String,
    },
    StopSession {
        executor_id: String,
        session_id: String,
    },
    Start {
        executor_id: String,
    },
    Status,
    Stop {
        executor_id: String,
    },
}

/// One paired executor, as the tray is allowed to see it: its daemon state,
/// whether its owner paused it, why it last stopped when it is not running,
/// how many program requests wait for an answer, and the team's saved
/// display-only name (`team_label`). Never a path or a key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorStatus {
    pub daemon_status: String,
    pub executor_id: String,
    pub workspace_configured: bool,
    pub paused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<Failure>,
    pub pending_program_requests: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub names: Option<TeamLabel>,
}

/// The answer. Each variant carries only what the tray asked for: an executor
/// list, a pairing result, the credential-free `describe` JSON, or whether a
/// removed connection's sign-off reached Nessie. Paths that belong to the
/// person reading them travel only inside `describe`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub enum Response {
    ManagedCustody {
        custody: serde_json::Value,
    },
    PersonalAttestation {
        authority: serde_json::Value,
    },
    InferenceConnections {
        connections: serde_json::Value,
    },
    Error {
        reason: String,
    },
    Ok {
        executors: Vec<ExecutorStatus>,
    },
    #[serde(rename = "pairOk")]
    PairOk {
        executor_id: String,
        fingerprint: String,
    },
    #[serde(rename = "describe")]
    DescribeOk {
        description: serde_json::Value,
    },
    Pairing {
        pairing: serde_json::Value,
    },
    Removed {
        signed_off: bool,
    },
    ProgramRequests {
        requests: Vec<nessie_windows_common::owner_controls::ProgramRequest>,
    },
    /// `sessions --json` as the CLI printed it, checked by `owner_sessions::parse_sessions`.
    Sessions {
        sessions: Vec<serde_json::Value>,
    },
}

impl Response {
    pub fn error(reason: impl Into<String>) -> Self {
        Self::Error {
            reason: reason.into(),
        }
    }

    /// One line, always terminated: the reader on the other side is line-framed.
    pub fn encode(&self) -> String {
        // The type is a closed set of strings and booleans, so serialization is
        // total; a failure here would be a bug in this file, not in a caller.
        format!("{}\n", serde_json::to_string(self).unwrap_or_else(|_| {
            r#"{"status":"error","reason":"The Nessie Computer service could not encode its answer."}"#
                .to_owned()
        }))
    }
}

/// The same rule the desktop companion applies to an executor id: it becomes a
/// path segment under the service's state root.
pub fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn identifier(value: String, field: &str) -> Result<String, String> {
    if valid_identifier(&value) {
        Ok(value)
    } else {
        Err(format!("The {field} is malformed."))
    }
}

/// Parses and validates one request line. A malformed line is refused in words
/// that never quote the line back: it may hold a pairing challenge.
pub fn parse_request(line: &str) -> Result<Command, String> {
    if line.len() > MAX_REQUEST_BYTES {
        return Err("The control request is malformed.".to_owned());
    }
    let request: Request =
        serde_json::from_str(line).map_err(|_| "The control request is malformed.".to_owned())?;
    match request {
        Request::ManagedCustody { operation } => {
            nessie_windows_common::custody::validate(&operation)?;
            Ok(Command::ManagedCustody { operation })
        }
        Request::PersonalAttestation {
            executor_id,
            operation,
        } => Ok(Command::PersonalAttestation {
            executor_id: identifier(executor_id, "team id")?,
            operation: crate::service_chatgpt::parse_operation(operation)?,
        }),
        Request::PairingStart {
            api_base_url,
            workspace_root: workspace,
            replace,
        } => Ok(Command::PairingStart {
            api_base_url: approved_api_base_url(&api_base_url)?,
            workspace_root: workspace_root(workspace)?,
            replace,
        }),
        Request::PairingStatus { executor_id } => {
            if let Some(ref id) = executor_id {
                if !valid_identifier(id) {
                    return Err("The team id is malformed.".to_owned());
                }
            }
            Ok(Command::PairingStatus { executor_id })
        }
        Request::PairingCancel => Ok(Command::PairingCancel),
        Request::PairingConfirm { claim_digest } => {
            if claim_digest.len() != 71
                || !claim_digest.starts_with("sha256:")
                || !claim_digest[7..]
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return Err("Review the organisation and team before confirming.".to_owned());
            }
            Ok(Command::PairingConfirm { claim_digest })
        }
        Request::Configure {
            executor_id,
            operation_keys,
        } => Ok(Command::Configure {
            executor_id: identifier(executor_id, "team id")?,
            operation_keys: workspace_operation_keys(operation_keys)?,
        }),
        Request::ConfigureInput {
            executor_id,
            configuration_input,
        } => Ok(Command::ConfigureInput {
            executor_id: identifier(executor_id, "team id")?,
            configuration_input,
        }),
        Request::InferenceConnections { executor_id, operation } => Ok(Command::InferenceConnections {
            executor_id: identifier(executor_id, "team id")?,
            operation: nessie_windows_common::inference_control::validate(operation)?,
        }),
        Request::Describe { executor_id } => Ok(Command::Describe {
            executor_id: identifier(executor_id, "team id")?,
        }),
        Request::EnrollControlClient {} => Ok(Command::EnrollControlClient),
        Request::Pair {
            api_base_url,
            challenge: value,
            enrollment_id,
            workspace_root: workspace,
        } => Ok(Command::Pair(PairCommand {
            api_base_url: approved_api_base_url(&api_base_url)?,
            challenge: challenge(value)?,
            enrollment_id: identifier(enrollment_id, "enrollment id")?,
            workspace_root: workspace_root(workspace)?,
        })),
        Request::Remove { executor_id } => Ok(Command::Remove {
            executor_id: identifier(executor_id, "team id")?,
        }),
        Request::SetPaused { executor_id, paused } => Ok(Command::SetPaused {
            executor_id: identifier(executor_id, "team id")?,
            paused,
        }),
        Request::ProgramRequests { executor_id } => Ok(Command::ProgramRequests {
            executor_id: identifier(executor_id, "team id")?,
        }),
        Request::AnswerProgramRequest { executor_id, id, answer } => {
            if !nessie_windows_common::owner_controls::valid_request_id(&id) {
                return Err("That request is no longer listed.".to_owned());
            }
            Ok(Command::AnswerProgramRequest {
                executor_id: identifier(executor_id, "team id")?,
                id,
                answer: Answer::parse(&answer)?,
            })
        }
        Request::Sessions { executor_id } => Ok(Command::Sessions {
            executor_id: identifier(executor_id, "team id")?,
        }),
        Request::StopSession { executor_id, session_id } => {
            if !nessie_windows_common::owner_sessions::valid_session_id(&session_id) {
                return Err("That session is no longer working on this computer.".to_owned());
            }
            Ok(Command::StopSession { executor_id: identifier(executor_id, "team id")?, session_id })
        }
        Request::Start { executor_id } => Ok(Command::Start {
            executor_id: identifier(executor_id, "team id")?,
        }),
        Request::Status => Ok(Command::Status),
        Request::Stop { executor_id } => Ok(Command::Stop {
            executor_id: identifier(executor_id, "team id")?,
        }),
    }
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod protocol_tests;
