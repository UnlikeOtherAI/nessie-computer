//! Fixed SYSTEM creator requests. No executable, argv, environment, source path
//! or claimed custody can be supplied by a graph/daemon on this wire.
use crate::{
    custody::{valid_nonce, Generation, REJECTED},
    execution::identifier,
};
use serde::{Deserialize, Serialize};
pub const PIPE: &str = r"\\.\pipe\NessieT3ExecutionCreator";
pub const COMPANION_PIPE: &str = r"\\.\pipe\NessieT3ExecutionCompanion";
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CompanionRole {
    Resource,
    ExecutionOffer,
    ExecutionEnroll,
    ExecutionGraph,
    ExecutionReserve,
    ExecutionPrepare,
    ExecutionAssociate,
    ExecutionSecretObserve,
}
impl CompanionRole {
    pub fn arguments(&self) -> Vec<&'static str> {
        match self {
            Self::Resource => vec!["t3-execution-resource"],
            Self::ExecutionOffer => vec!["t3-execution", "offer"],
            Self::ExecutionEnroll => vec!["t3-execution", "enroll"],
            Self::ExecutionGraph => vec!["t3-execution", "graph"],
            Self::ExecutionReserve => vec!["t3-execution", "reserve"],
            Self::ExecutionPrepare => vec!["t3-execution", "prepare"],
            Self::ExecutionAssociate => vec!["t3-execution", "associate"],
            Self::ExecutionSecretObserve => vec!["t3-execution", "secret-observe"],
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    RegisterSessionHost {
        nonce: String,
        child_pid: u32,
        job_name: String,
    },
    SessionContext {
        nonce: String,
    },
    ClearSessionHost {
        nonce: String,
    },
    AuthorizeGraph {
        executor_id: String,
        requester_pid: u32,
        nonce: String,
    },
    RegisterGraph {
        nonce: String,
        child_pid: u32,
        job_name: String,
    },
    AuthorizeCompanion {
        graph_pid: u32,
        role: CompanionRole,
        nonce: String,
    },
    RegisterCompanion {
        nonce: String,
        child_pid: u32,
        job_name: String,
    },
    Clear {
        nonce: String,
    },
}
impl Request {
    pub fn validate(&self) -> Result<(), String> {
        let (nonce, valid) = match self {
            Self::RegisterSessionHost {
                nonce,
                child_pid,
                job_name,
            } => (
                nonce,
                *child_pid > 0 && job_name == &format!(r"Global\NessieCustodyHost-{nonce}"),
            ),
            Self::SessionContext { nonce } | Self::ClearSessionHost { nonce } => (nonce, true),
            Self::AuthorizeGraph {
                executor_id,
                requester_pid,
                nonce,
            } => (nonce, identifier(executor_id) && *requester_pid > 0),
            Self::AuthorizeCompanion {
                graph_pid, nonce, ..
            } => (nonce, *graph_pid > 0),
            Self::RegisterGraph {
                nonce,
                child_pid,
                job_name,
            }
            | Self::RegisterCompanion {
                nonce,
                child_pid,
                job_name,
            } => (
                nonce,
                *child_pid > 0
                    && job_name
                        .strip_prefix(r"Global\NessieCustody-")
                        .is_some_and(valid_nonce),
            ),
            Self::Clear { nonce } => (nonce, true),
        };
        if !valid || !valid_nonce(nonce) {
            return Err(REJECTED.into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Creation {
    pub executor_id: String,
    pub creator: Generation,
    #[serde(default)]
    pub session_host: Option<Generation>,
    #[serde(default)]
    pub host_job_name: Option<String>,
    pub requester: Generation,
    pub graph: Option<Generation>,
    pub role: Option<CompanionRole>,
    pub owner_sid: String,
    pub session_id: u32,
    pub state_directory: String,
    pub release_digest: String,
    pub child: Option<Generation>,
    pub job_name: Option<String>,
    pub expires_at_ms: u64,
    pub cleared: bool,
    #[serde(default)]
    pub cleared_at_ms: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn caller_cannot_choose_executable_or_claim_role_generation() {
        let request = json!({"operation":"authorizeCompanion","graphPid":42,
            "role":"resource","nonce":"a".repeat(64)});
        assert!(serde_json::from_value::<Request>(request.clone())
            .unwrap()
            .validate()
            .is_ok());
        for (field, value) in [
            ("command", json!("other.exe")),
            ("ownerSid", json!("S-1-5-18")),
            ("generation", json!("caller")),
            ("approved", json!(true)),
        ] {
            let mut changed = request.clone();
            changed[field] = value;
            assert!(serde_json::from_value::<Request>(changed).is_err());
        }
        let mut changed = request;
        changed["role"] = json!("provider");
        assert!(serde_json::from_value::<Request>(changed).is_err());
    }
    #[test]
    fn fixed_resource_role_has_no_argument_surface() {
        assert_eq!(
            CompanionRole::Resource.arguments(),
            vec!["t3-execution-resource"]
        );
        assert_eq!(
            CompanionRole::ExecutionPrepare.arguments(),
            vec!["t3-execution", "prepare"]
        );
        assert_eq!(
            CompanionRole::ExecutionSecretObserve.arguments(),
            vec!["t3-execution", "secret-observe"]
        );
        assert!(Request::RegisterGraph {
            nonce: "a".repeat(64),
            child_pid: 1,
            job_name: format!(r"Global\\NessieCustody-{}", "a".repeat(64))
        }
        .validate()
        .is_err());
    }
}
