//! The named-pipe control protocol: one JSON object per line, in and out.
//!
//! The tray is a stateless client of the CLI, so the protocol exposes the
//! commands it needs: `status`, `pair`, `start`, `stop`, `describe`,
//! `configureInput`, and `remove`. `describe` returns the same credential-free
//! JSON the CLI prints; `configureInput` carries the whole stdin payload for
//! `configure --configuration-input-stdin`; `remove` runs the CLI's `unpair`
//! and answers only whether Nessie heard the sign-off. This keeps the tray from
//! ever opening `executor-state.json` while still letting it show folders,
//! origins, and permitted commands.
//!
//! Everything here is a pure function of the request text, so both halves of the
//! contract are tested on any host.

use serde::{Deserialize, Serialize};

/// The workspace operations the local policy may allow, in canonical order.
pub const WORKSPACE_OPERATION_KEYS: [&str; 5] = [
    "file.list",
    "file.read",
    "file.write",
    "workspace.review",
    "sandbox.stop",
];

/// The longest pairing challenge the API mints, matched to the desktop
/// companion's own bound so neither accepts what the other refuses.
const MAX_CHALLENGE_BYTES: usize = 8_192;

/// Windows' extended path limit. A workspace root longer than this cannot name
/// a real directory.
const MAX_WORKSPACE_BYTES: usize = 32_767;

const MAX_IDENTIFIER_BYTES: usize = 128;

/// The longest request line the pipe will read. A pairing challenge plus a
/// workspace path plus JSON framing fits with room to spare; anything larger is
/// a caller that has lost the protocol, not a command.
pub const MAX_REQUEST_BYTES: usize = 65_536;

const NESSIE_API_BASE_URL: &str = "https://api.nessie.works";
const DEEPTEST_API_BASE_URL: &str = "https://api.deeptest.live";
const LOOPBACK_API_BASE_URLS: [&str; 2] = ["http://127.0.0.1:5454", "http://localhost:5454"];

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
    Start {
        executor_id: String,
    },
    Status,
    Stop {
        executor_id: String,
    },
}

/// One paired executor, as the tray is allowed to see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorStatus {
    pub daemon_status: String,
    pub executor_id: String,
    pub workspace_configured: bool,
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
            r#"{"status":"error","reason":"The Nessie Executor service could not encode its answer."}"#
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

fn approved_api_base_url(value: &str) -> Result<String, String> {
    if value == NESSIE_API_BASE_URL || value == DEEPTEST_API_BASE_URL {
        return Ok(value.to_owned());
    }
    // A local owner may deliberately pair to this machine's development API.
    // This is a closed loopback set, not a general HTTP exception: a pasted
    // invitation can never route the machine key to a LAN or internet host.
    if LOOPBACK_API_BASE_URLS.contains(&value) {
        return Ok(value.to_owned());
    }
    // Nessie is open source and self-hosted. Anything else must be an HTTPS
    // origin with no credentials, path, query or fragment — the same rule the
    // shared schema enforces so one host cannot be dressed up as another.
    let parsed = value.parse::<url::Url>().map_err(|_| {
        "Choose Nessie cloud, DeepTest, an approved local API, or an HTTPS origin.".to_owned()
    })?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Enter the server address without a username or password.".to_owned());
    }
    if parsed.query().is_some()
        || parsed.fragment().is_some()
        || !(parsed.path() == "/" || parsed.path().is_empty())
    {
        return Err(
            "Enter only the server address, without a page path or anything after it.".to_owned(),
        );
    }
    if parsed.scheme() == "https" {
        Ok(parsed.origin().unicode_serialization())
    } else {
        Err("The server address must start with https://.".to_owned())
    }
}

fn challenge(value: String) -> Result<String, String> {
    if value.is_empty() || value.len() > MAX_CHALLENGE_BYTES || value.contains('\0') {
        return Err("The pairing challenge is malformed.".to_owned());
    }
    Ok(value)
}

fn workspace_root(value: String) -> Result<String, String> {
    if value.is_empty()
        || value.len() > MAX_WORKSPACE_BYTES
        || value.contains('\0')
        || !std::path::Path::new(&value).is_absolute()
    {
        return Err("Choose one existing absolute workspace directory.".to_owned());
    }
    Ok(value)
}

/// Canonicalizes the requested policy the way the desktop companion does: a
/// known set, each key at most once, always in the one declared order.
pub fn workspace_operation_keys(requested: Vec<String>) -> Result<Vec<String>, String> {
    if requested.is_empty()
        || requested.len() > WORKSPACE_OPERATION_KEYS.len()
        || requested
            .iter()
            .any(|key| !WORKSPACE_OPERATION_KEYS.contains(&key.as_str()))
    {
        return Err("Choose one or more supported workspace operations.".to_owned());
    }
    let mut unique = requested.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != requested.len() {
        return Err("Choose each workspace operation only once.".to_owned());
    }
    Ok(WORKSPACE_OPERATION_KEYS
        .iter()
        .filter(|key| requested.iter().any(|value| value == *key))
        .map(|key| (*key).to_owned())
        .collect())
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
            executor_id: identifier(executor_id, "executor id")?,
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
                    return Err("The executor id is malformed.".to_owned());
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
            executor_id: identifier(executor_id, "executor id")?,
            operation_keys: workspace_operation_keys(operation_keys)?,
        }),
        Request::ConfigureInput {
            executor_id,
            configuration_input,
        } => Ok(Command::ConfigureInput {
            executor_id: identifier(executor_id, "executor id")?,
            configuration_input,
        }),
        Request::Describe { executor_id } => Ok(Command::Describe {
            executor_id: identifier(executor_id, "executor id")?,
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
            executor_id: identifier(executor_id, "executor id")?,
        }),
        Request::Start { executor_id } => Ok(Command::Start {
            executor_id: identifier(executor_id, "executor id")?,
        }),
        Request::Status => Ok(Command::Status),
        Request::Stop { executor_id } => Ok(Command::Stop {
            executor_id: identifier(executor_id, "executor id")?,
        }),
    }
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod protocol_tests;
