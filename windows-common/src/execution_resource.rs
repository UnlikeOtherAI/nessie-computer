//! Private native/service resource wire. Handles never cross the daemon lane.
use crate::custody::{valid_nonce, REJECTED};
use serde::{Deserialize, Serialize};

pub const SETTINGS_LIMIT: usize = 1024 * 1024;
pub const LEASE_MILLIS: u64 = 55_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub executor_id: String,
    pub admitted_root_key: String,
    pub physical_root_key: String,
    pub environment_id: String,
    pub database_identity: String,
    pub environment_identity: String,
    pub layout: String,
    pub database_role: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderReference {
    pub reference_id: String,
    pub instance_id: String,
    pub driver: String,
    pub role: String,
    pub identity: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    pub source: Source,
    pub settings_identity: String,
    pub settings_digest: String,
    pub settings_length: usize,
    pub provider_references: Vec<ProviderReference>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub version: u32,
    pub resource_id: String,
    pub resource_generation: String,
    pub evidence: Evidence,
    pub custody: crate::execution::Custody,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Object {
    pub handle: u64,
    pub identity: String,
    pub kind: String,
    pub private: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "operation", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Request {
    Authorize { executor_id: String },
    Register { executor_id: String, resource_id: String, evidence: Evidence, objects: Vec<Object>, watches: Vec<u64> },
    Recheck { executor_id: String, resource_id: String },
    Close { executor_id: String, resource_id: String },
}
impl Request {
    pub fn executor(&self) -> &str {
        match self {
            Self::Authorize { executor_id } | Self::Register { executor_id, .. }
            | Self::Recheck { executor_id, .. } | Self::Close { executor_id, .. } => executor_id,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        let id = |s: &str| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control);
        if !id(self.executor()) { return Err(REJECTED.into()); }
        match self {
            Self::Authorize { .. } => (),
            Self::Close { resource_id, .. } | Self::Recheck { resource_id, .. } => {
                if !valid_nonce(resource_id) { return Err(REJECTED.into()); }
            }
            Self::Register { resource_id, evidence: e, objects, watches, .. } => {
                if !valid_nonce(resource_id) || e.source.executor_id != self.executor()
                    || e.settings_length == 0 || e.settings_length > SETTINGS_LIMIT
                    || !valid_nonce(&e.settings_digest) || !id(&e.settings_identity)
                    || objects.is_empty() || objects.len() > 256 || e.provider_references.len() > 192
                    || watches.is_empty() || watches.len() > 128 || watches.contains(&0)
                    || ![&e.source.admitted_root_key, &e.source.physical_root_key, &e.source.environment_id,
                        &e.source.database_identity, &e.source.environment_identity].iter().all(|s| id(s))
                    || !matches!((e.source.layout.as_str(), e.source.database_role.as_str()),
                        ("v2-80", "authoritative-v2") | ("legacy-54", "sole-legacy")) {
                    return Err(REJECTED.into());
                }
                let mut refs = std::collections::HashSet::new();
                for r in &e.provider_references {
                    if !valid_nonce(&r.reference_id) || !refs.insert(&r.reference_id)
                        || !id(&r.instance_id) || !id(&r.identity)
                        || !["codex", "claude"].contains(&r.driver.as_str())
                        || !["continuation", "history", "credential"].contains(&r.role.as_str()) {
                        return Err(REJECTED.into());
                    }
                }
                if objects.iter().any(|o| o.handle == 0 || !id(&o.identity)
                    || !["directory", "source-root", "settings", "database", "environment", "sidecar", "configuration", "provider-home"]
                        .contains(&o.kind.as_str()) || (o.kind != "directory" && !o.private)) {
                    return Err(REJECTED.into());
                }
            }
        }
        Ok(())
    }
}
