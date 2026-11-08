//! Execution-purpose wire; prospective IDs never masquerade as provider identities.
use crate::custody::{valid_nonce, Generation, REJECTED};
use serde::{Deserialize, Serialize};
#[path = "execution_inspection.rs"]
mod inspection;
pub use inspection::Inspection;
#[cfg(test)]
#[path = "execution_tests.rs"]
mod tests;
pub const ADMISSION_DOMAIN: &str = "nessie.t3.execution.admission.v1";
pub const INSPECTION_DOMAIN: &str = "nessie.t3.execution.inspection.v1";
pub const ISSUER_DOMAIN: &str = "nessie.t3.execution.issuer.v1";
pub const RESERVATION_DOMAIN: &str = "nessie.t3.execution.reservation.v1";
pub const GRAPH_DOMAIN: &str = "nessie.t3.execution.graph.v1";
pub const PREPARATION_DOMAIN: &str = "nessie.t3.execution.preparation.v1";
pub const ASSOCIATION_DOMAIN: &str = "nessie.t3.execution.association.v1";
pub fn identifier(v: &str) -> bool {
    !v.is_empty() && v.len() <= 2048 && !v.contains('\0')
}
pub fn digest(v: &str) -> bool {
    v.strip_prefix("sha256:").is_some_and(valid_nonce)
}
pub fn now_ms() -> Result<u64, String> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| REJECTED)?
        .as_millis()
        .try_into()
        .map_err(|_| REJECTED)?)
}
pub fn signing_bytes(domain: &str, payload: &str) -> Vec<u8> {
    format!("{domain}\n{payload}").into_bytes()
}
pub fn canonical(value: &serde_json::Value) -> Result<String, String> {
    use serde_json::Value;
    Ok(match value {
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort_by_key(|k| k.encode_utf16().collect::<Vec<_>>());
            let mut parts = Vec::new();
            for k in keys {
                parts.push(format!(
                    "{}:{}",
                    serde_json::to_string(k).map_err(|_| REJECTED)?,
                    canonical(&object[k])?
                ));
            }
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        ),
        Value::Number(n) if n.as_u64().is_none_or(|n| n > 9_007_199_254_740_991) => {
            return Err(REJECTED.into())
        }
        _ => serde_json::to_string(value).map_err(|_| REJECTED)?,
    })
}
pub fn value_digest(value: &serde_json::Value) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(canonical(value)?.as_bytes())
    ))
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub executor_id: String,
    pub environment_id: String,
    pub thread_id: String,
    pub provider_instance_id: String,
    pub connection_epoch: String,
    pub runtime_generation: String,
    pub correlation_id: String,
    pub command_id: String,
    pub request_sha256: String,
    pub relay_hmac: String,
    pub actor_reference: String,
    pub initiation_reference: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_evidence_digest: Option<String>,
    pub source_root_key: String,
    pub source_generation: String,
    pub driver: String,
    pub continuation_home_key: String,
    pub history_home_key: String,
    pub credential_binding_id: String,
}
impl Binding {
    pub fn validate(&self, graph: bool) -> Result<(), String> {
        if ![
            &self.executor_id,
            &self.environment_id,
            &self.thread_id,
            &self.provider_instance_id,
            &self.connection_epoch,
            &self.runtime_generation,
            &self.correlation_id,
            &self.command_id,
            &self.source_root_key,
            &self.source_generation,
            &self.continuation_home_key,
            &self.history_home_key,
            &self.credential_binding_id,
        ]
        .iter()
        .all(|s| identifier(s))
            || ![
                &self.request_sha256,
                &self.actor_reference,
                &self.initiation_reference,
            ]
            .iter()
            .all(|s| digest(s))
            || !self
                .relay_hmac
                .strip_prefix("hmac-sha256:")
                .is_some_and(valid_nonce)
            || !["codex", "claude"].contains(&self.driver.as_str())
            || (if graph {
                self.source_evidence_digest.is_some()
            } else {
                !self.source_evidence_digest.as_deref().is_some_and(digest)
            })
        {
            return Err(REJECTED.into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Admission {
    pub version: u32,
    pub phase: String,
    pub binding: Binding,
    pub reservation_id: String,
    pub issuer_key_id: String,
    pub release_digest: String,
    pub nonce: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
}
impl Admission {
    pub fn validate(&self, now: u64) -> Result<(), String> {
        self.binding.validate(false)?;
        let shape = match self.phase.as_str() {
            "reserve" => self.launch_digest.is_none() && self.provider_session_id.is_none(),
            "launch" => {
                self.launch_digest.as_deref().is_some_and(digest)
                    && self.provider_session_id.is_none()
            }
            "associate" => {
                self.launch_digest.as_deref().is_some_and(digest)
                    && self.provider_session_id.as_deref().is_some_and(identifier)
            }
            _ => false,
        };
        if self.version != 1
            || !shape
            || ![
                &self.reservation_id,
                &self.issuer_key_id,
                &self.release_digest,
                &self.nonce,
            ]
            .iter()
            .all(|s| valid_nonce(s))
            || self.expires_at_ms <= now
            || self.issued_at_ms > now.saturating_add(2000)
            || self.expires_at_ms <= self.issued_at_ms
            || self.expires_at_ms - self.issued_at_ms > 5000
        {
            return Err(REJECTED.into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedAdmission {
    pub payload: String,
    pub key_id: String,
    pub signature: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Custody {
    pub service: Generation,
    pub controller: Generation,
    pub supervisor: Generation,
    pub runtime: Generation,
    pub job_name: String,
    pub release_digest: String,
    pub service_image_digest: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Descriptor {
    pub version: u32,
    pub executor_id: String,
    pub paired_origin: String,
    pub key_id: String,
    pub public_key: String,
    pub custody: Custody,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Challenge {
    pub version: u32,
    pub enrollment_id: String,
    pub executor_id: String,
    pub paired_origin: String,
    pub descriptor_digest: String,
    pub nonce: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}
impl Challenge {
    pub fn validate(&self, now: u64) -> Result<(), String> {
        if self.version != 1
            || !identifier(&self.executor_id)
            || !valid_nonce(&self.enrollment_id)
            || !valid_nonce(&self.nonce)
            || !digest(&self.descriptor_digest)
            || self.expires_at_ms <= now
            || self.issued_at_ms > now.saturating_add(2000)
            || self.expires_at_ms <= self.issued_at_ms
            || self.expires_at_ms - self.issued_at_ms > 300000
        {
            return Err(REJECTED.into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Launch {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub environment: std::collections::BTreeMap<String, String>,
}
impl Launch {
    pub fn validate(&self) -> Result<(), String> {
        if !std::path::Path::new(&self.command).is_absolute()
            || !std::path::Path::new(&self.cwd).is_absolute()
            || self.args.len() > 256
            || self.environment.len() > 256
            || self
                .args
                .iter()
                .any(|s| s.len() > 32768 || s.contains('\0'))
            || self.environment.iter().any(|(k, v)| {
                !identifier(k) || k.contains('=') || v.len() > 32768 || v.contains('\0')
            })
        {
            return Err(REJECTED.into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Offer {
        executor_id: String,
    },
    Review {
        challenge: Challenge,
    },
    Approve {
        challenge: Challenge,
    },
    Graph {
        inspection: SignedAdmission,
        resource_id: String,
        graph: Graph,
    },
    Reserve {
        admission: SignedAdmission,
    },
    Prepare {
        executor_id: String,
        reservation_id: String,
        provider_session_id: String,
        launch: Launch,
    },
    Launch {
        admission: SignedAdmission,
    },
    Associate {
        admission: SignedAdmission,
    },
    Observe {
        executor_id: String,
        reservation_id: String,
        child_pid: u32,
        stdout_handle: u64,
        output_handle: u64,
        provider_session_id: String,
    },
}
impl Request {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Offer { executor_id } if identifier(executor_id) => Ok(()),
            Self::Graph {
                inspection,
                resource_id,
                graph,
            } => {
                if !valid_nonce(resource_id)
                    || inspection.payload.len() > 32768
                    || inspection.signature.len() > 2048
                    || !identifier(&inspection.key_id)
                {
                    return Err(REJECTED.into());
                }
                serde_json::from_str::<Inspection>(&inspection.payload)
                    .map_err(|_| REJECTED)?
                    .validate(now_ms()?)?;
                graph.validate()
            }
            Self::Review { challenge } | Self::Approve { challenge } => {
                challenge.validate(now_ms()?)
            }
            Self::Reserve { admission }
            | Self::Launch { admission }
            | Self::Associate { admission } => {
                if admission.payload.len() > 32768
                    || admission.signature.len() > 2048
                    || !identifier(&admission.key_id)
                {
                    return Err(REJECTED.into());
                }
                serde_json::from_str::<Admission>(&admission.payload)
                    .map_err(|_| REJECTED)?
                    .validate(now_ms()?)
            }
            Self::Prepare {
                executor_id,
                reservation_id,
                provider_session_id,
                launch,
            } if identifier(executor_id)
                && valid_nonce(reservation_id)
                && identifier(provider_session_id) =>
            {
                launch.validate()
            }
            Self::Observe {
                executor_id,
                reservation_id,
                child_pid,
                stdout_handle,
                output_handle,
                provider_session_id,
            } if identifier(executor_id)
                && valid_nonce(reservation_id)
                && *child_pid > 0
                && *stdout_handle > 0
                && *output_handle > 0
                && identifier(provider_session_id) =>
            {
                Ok(())
            }
            _ => Err(REJECTED.into()),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub kind: String,
    pub id: String,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Graph {
    pub version: u32,
    pub nonce: String,
    pub binding: Binding,
    pub source_revision: String,
    pub targets: Vec<Target>,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}
impl Graph {
    pub fn validate(&self) -> Result<(), String> {
        self.binding.validate(true)?;
        let now = now_ms()?;
        if self.version != 1
            || !valid_nonce(&self.nonce)
            || self.source_revision != "25bf84ab07f53f141c20239c63e383823a9d5ea0"
            || self.targets.len() > 256
            || self.expires_at_ms <= now
            || self.issued_at_ms > now.saturating_add(2000)
            || self.expires_at_ms <= self.issued_at_ms
            || self.expires_at_ms - self.issued_at_ms > 5000
            || self.targets.iter().any(|t| {
                ![
                    "thread",
                    "project",
                    "environment",
                    "workspace",
                    "attachment",
                    "terminal",
                    "scheduled-task",
                    "provider-instance",
                    "turn-item",
                ]
                .contains(&t.kind.as_str())
                    || t.id.is_empty()
                    || t.id.len() > 32768
                    || t.id.contains('\0')
                    || !["existing", "create", "resolve"].contains(&t.scope.as_str())
                    || t.environment_id.as_deref().is_some_and(|s| !identifier(s))
            })
        {
            return Err(REJECTED.into());
        }
        Ok(())
    }
}
