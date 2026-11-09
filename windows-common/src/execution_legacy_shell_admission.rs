//! One finite complete legacy-shell action, separate from row claims/provider input.
use crate::{
    custody::{valid_nonce, REJECTED},
    execution::{digest, identifier, value_digest, Binding},
    execution_legacy_shell::{Observation, MAX_TARGETS},
    execution_resource::DestinationEvidence,
};
use serde::{Deserialize, Serialize};
pub const PREPARATION_DOMAIN: &str = "nessie.t3.execution.legacy-shell-preparation.v1";
pub const DOMAIN: &str = "nessie.t3.execution.legacy-shell.v1";
pub const SLOT_DOMAIN: &str = "nessie.t3.execution.legacy-shell-slot.v1";
#[cfg(test)]
#[path = "execution_legacy_shell_admission_tests.rs"]
mod tests;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preparation {
    pub version: u32,
    pub action: String,
    pub binding: Binding,
    pub accepted_graph_nonce: String,
    pub slot_id: String,
    pub evidence: DestinationEvidence,
    pub observation: Observation,
    pub nonce: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuer_key_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preparation_receipt_digest: Option<String>,
}
pub fn slot_id(binding: &Binding, nonce: &str) -> Result<String, String> {
    binding.validate(false)?;
    if !valid_nonce(nonce) {
        return Err(REJECTED.into());
    }
    Ok(value_digest(
        &serde_json::json!({"domain":SLOT_DOMAIN,"executorId":binding.executor_id,
        "sourceEvidenceDigest":binding.source_evidence_digest,"acceptedGraphNonce":nonce}),
    )?
    .strip_prefix("sha256:")
    .ok_or(REJECTED)?
    .into())
}
impl Preparation {
    pub fn validate(&self, now: u64, admission: bool) -> Result<(), String> {
        self.binding.validate(false)?;
        let e = &self.evidence;
        if self.version != 1
            || self.action != "legacy-shell-reconcile"
            || self.observation.version != 1
            || self.observation.targets.len() > MAX_TARGETS
            || !digest(&self.observation.plan_digest)
            || self.issued_at_ms > now
            || self.expires_at_ms <= now
            || self.expires_at_ms <= self.issued_at_ms
            || self.issued_at_ms < self.observation.observed_at_ms
            || self.expires_at_ms > self.observation.observed_at_ms.saturating_add(5000)
            || self.expires_at_ms > 9_007_199_254_740_991
            || !valid_nonce(&self.nonce)
            || self.slot_id != slot_id(&self.binding, &self.accepted_graph_nonce)?
            || !valid_nonce(&e.resource_id)
            || !digest(&e.resource_generation)
            || !valid_nonce(&e.settings_digest)
            || ![
                &e.source_database_identity,
                &e.destination_database_identity,
                &e.settings_identity,
            ]
            .into_iter()
            .all(|id| identifier(id))
        {
            return Err(REJECTED.into());
        }
        for target in &self.observation.targets {
            target.validate()?;
        }
        if admission {
            if !self.issuer_key_id.as_deref().is_some_and(valid_nonce)
                || !self
                    .preparation_receipt_digest
                    .as_deref()
                    .is_some_and(digest)
            {
                return Err(REJECTED.into());
            }
        } else if self.nonce != self.slot_id
            || self.issued_at_ms != self.observation.observed_at_ms
            || self.issuer_key_id.is_some()
            || self.preparation_receipt_digest.is_some()
        {
            return Err(REJECTED.into());
        }
        Ok(())
    }
    pub fn matches(&self, prepared: &Self, issuer: &str, receipt_digest: &str) -> bool {
        let mut selected = self.clone();
        selected.issuer_key_id = None;
        selected.preparation_receipt_digest = None;
        selected.nonce = prepared.nonce.clone();
        selected.issued_at_ms = prepared.issued_at_ms;
        selected.expires_at_ms = prepared.expires_at_ms;
        self.issuer_key_id.as_deref() == Some(issuer)
            && self.preparation_receipt_digest.as_deref() == Some(receipt_digest)
            && self.issued_at_ms >= prepared.issued_at_ms
            && self.expires_at_ms <= prepared.expires_at_ms
            && selected == *prepared
    }
}
