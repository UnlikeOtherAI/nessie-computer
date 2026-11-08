//! Public-only service custody wire. No caller-selected executable or credential bytes.
use serde::{Deserialize, Serialize};

pub const VERSION: u32 = 2;
pub const REJECTED: &str = "Windows managed runtime custody could not be verified.";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Generation {
    pub pid: u32,
    pub started_at: String,
    pub boot_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub protocol_version: u32,
    pub guard_version: u32,
    pub supervisor: Generation,
    pub child: Generation,
    pub owner_sid: String,
    pub session_id: u32,
    pub release_digest: String,
    pub job_name: String,
    pub kind: RuntimeKind,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeKind {
    T3SessionGraph,
    Guarded,
    MachineAttestation,
    ServiceDaemon,
    ServiceControl,
    UserDaemon,
    PublicController,
    Credential,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    ExecutionResource { request: Box<crate::execution_resource::Request> },
    Execution { request: crate::execution::Request },
    Status,
    HostCheck,
    Register {
        child_pid: u32,
        job_name: String,
        release_digest: String,
        kind: RuntimeKind,
    },
    Inventory {
        nonce: String,
    },
    Revoke {
        epoch: String,
    },
    Clear {
        epoch: String,
    },
    Recover {
        epoch: String,
    },
    Release {
        nonce: String,
    },
    HostAcquire {
        nonce: String,
    },
    HostRelease {
        nonce: String,
    },
}

pub fn valid_nonce(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
pub fn validate(operation: &Operation) -> Result<(), String> {
    let valid = match operation {
        Operation::ExecutionResource { request } => return request.validate(),
        Operation::Execution { request } => return request.validate(),
        Operation::Status | Operation::HostCheck => true,
        Operation::Register {
            child_pid,
            job_name,
            release_digest,
            ..
        } => {
            *child_pid > 0
                && *child_pid <= i32::MAX as u32
                && valid_nonce(release_digest)
                && job_name
                    .strip_prefix("Global\\NessieCustody-")
                    .is_some_and(valid_nonce)
        }
        Operation::Inventory { nonce }
        | Operation::Release { nonce }
        | Operation::HostAcquire { nonce }
        | Operation::HostRelease { nonce } => valid_nonce(nonce),
        Operation::Revoke { epoch } | Operation::Clear { epoch } | Operation::Recover { epoch } => {
            valid_nonce(epoch)
        }
    };
    if valid {
        Ok(())
    } else {
        Err(REJECTED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn custody_wire_refuses_paths_credentials_and_unknown_operations() {
        for value in [
            serde_json::json!({"operation":"inventory","nonce":"a".repeat(64),"token":"secret"}),
            serde_json::json!({"operation":"register","childPid":42,"jobName":"C:\\job","releaseDigest":"a".repeat(64)}),
            serde_json::json!({"operation":"execute","command":"cmd.exe"}),
        ] {
            let parsed = serde_json::from_value::<Operation>(value);
            assert!(parsed.is_err() || validate(&parsed.unwrap()).is_err());
        }
    }
    #[test]
    fn generations_and_named_jobs_are_bounded_structural_facts() {
        assert!(validate(&Operation::Register {
            child_pid: 42,
            job_name: format!("Global\\NessieCustody-{}", "a".repeat(64)),
            release_digest: "b".repeat(64),
            kind: RuntimeKind::Guarded
        })
        .is_ok());
        assert!(!valid_nonce("secret"));
    }
}
