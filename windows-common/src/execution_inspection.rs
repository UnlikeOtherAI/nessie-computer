//! Nonexecuting inspection challenges are distinct from finite effect admission.
use crate::{
    custody::{valid_nonce, REJECTED},
    execution::{digest, identifier, Graph, Target},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Inspection {
    pub version: u32,
    pub inspection_id: String,
    pub issuer_key_id: String,
    pub nonce: String,
    pub executor_id: String,
    pub environment_id: String,
    pub connection_epoch: String,
    pub runtime_generation: String,
    pub correlation_id: String,
    pub command_id: String,
    pub request_sha256: String,
    pub relay_hmac: String,
    pub actor_reference: String,
    pub initiation_reference: String,
    pub source_root_key: String,
    pub source_generation: String,
    pub source_revision: String,
    pub targets: Vec<Target>,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}
impl Inspection {
    pub fn validate(&self, now: u64) -> Result<(), String> {
        if self.version != 1
            || ![&self.inspection_id, &self.issuer_key_id, &self.nonce]
                .iter()
                .all(|s| valid_nonce(s))
            || ![
                &self.executor_id,
                &self.environment_id,
                &self.connection_epoch,
                &self.runtime_generation,
                &self.correlation_id,
                &self.command_id,
                &self.source_root_key,
                &self.source_generation,
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
            || self.source_revision != "25bf84ab07f53f141c20239c63e383823a9d5ea0"
            || self.expires_at_ms <= now
            || self.issued_at_ms > now.saturating_add(2000)
            || self.expires_at_ms <= self.issued_at_ms
            || self.expires_at_ms - self.issued_at_ms > 5000
            || self.targets.len() > 256
        {
            return Err(REJECTED.into());
        }
        Ok(())
    }
    pub fn matches_graph(&self, graph: &Graph) -> Result<(), String> {
        let b = &graph.binding;
        if self.nonce != graph.nonce
            || self.executor_id != b.executor_id
            || self.environment_id != b.environment_id
            || self.connection_epoch != b.connection_epoch
            || self.runtime_generation != b.runtime_generation
            || self.correlation_id != b.correlation_id
            || self.command_id != b.command_id
            || self.request_sha256 != b.request_sha256
            || self.relay_hmac != b.relay_hmac
            || self.actor_reference != b.actor_reference
            || self.initiation_reference != b.initiation_reference
            || self.source_root_key != b.source_root_key
            || self.source_generation != b.source_generation
            || self.source_revision != graph.source_revision
            || self.targets != graph.targets
            || graph.issued_at_ms < self.issued_at_ms
            || graph.expires_at_ms > self.expires_at_ms
        {
            return Err(REJECTED.into());
        }
        Ok(())
    }
}
