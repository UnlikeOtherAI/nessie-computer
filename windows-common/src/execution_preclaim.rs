//! Finite SQL lease/attempt transition only. No provider or filesystem effect.
use crate::{
    custody::{valid_nonce, REJECTED},
    execution::{digest, identifier, value_digest, Binding},
    execution_command_lineage::BoundObservation,
};
use serde::{Deserialize, Serialize};
pub const PREPARATION_DOMAIN: &str = "nessie.t3.execution.sql-preclaim-preparation.v1";
pub const DOMAIN: &str = "nessie.t3.execution.sql-preclaim.v1";
pub const ID_DOMAIN: &str = "nessie.t3.execution.sql-preclaim.slot.v1";
#[cfg(test)]
#[path = "execution_preclaim_tests.rs"]
mod tests;
pub use crate::execution_resource::DestinationEvidence as Evidence;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preclaim {
    pub version: u32,
    pub action: String,
    pub binding: Binding,
    pub accepted_graph_nonce: String,
    pub claim_id: String,
    pub evidence: Evidence,
    pub bound: BoundObservation,
    pub nonce: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuer_key_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preparation_receipt_digest: Option<String>,
}
pub fn claim_id(
    binding: &Binding,
    nonce: &str,
    effect: &str,
    attempt: i64,
) -> Result<String, String> {
    binding.validate(false)?;
    if !valid_nonce(nonce) || !identifier(effect) || !(0..9_007_199_254_740_991).contains(&attempt)
    {
        return Err(REJECTED.into());
    }
    Ok(value_digest(
        &serde_json::json!({"domain":ID_DOMAIN,"executorId":binding.executor_id,
        "sourceEvidenceDigest":binding.source_evidence_digest,"acceptedGraphNonce":nonce,
        "effectId":effect,"attemptCount":attempt}),
    )?
    .strip_prefix("sha256:")
    .ok_or(REJECTED)?
    .into())
}
impl Preclaim {
    pub fn validate(&self, now: u64, admission: bool) -> Result<(), String> {
        self.binding.validate(false)?;
        let row = &self.bound.observation;
        let original = &self.bound.original;
        let e = &self.evidence;
        if self.version != 1
            || self.action != "claim-original-provider-turn-start"
            || self.expires_at_ms <= now
            || self.issued_at_ms > now
            || self.expires_at_ms <= self.issued_at_ms
            || self.issued_at_ms < row.observed_at_ms
            || self.expires_at_ms > row.observed_at_ms.saturating_add(5000)
            || self.expires_at_ms > 9_007_199_254_740_991
            || !valid_nonce(&self.accepted_graph_nonce)
            || !valid_nonce(&self.nonce)
            || !valid_nonce(&e.resource_id)
            || !valid_nonce(&e.settings_digest)
            || !digest(&e.resource_generation)
            || ![
                &e.source_database_identity,
                &e.destination_database_identity,
                &e.settings_identity,
            ]
            .into_iter()
            .all(|id| identifier(id))
            || row.version != 1
            || row.effect_type != "provider-turn.start"
            || row.command_type != "prepared-run.release"
            || row.command_id != original.release_command_id
            || row.thread_id != original.thread_id
            || row.receipt_digest != original.release_receipt_digest
            || original.parent_command_id != self.binding.command_id
            || original.thread_id != self.binding.thread_id
            || original.provider_instance_id != self.binding.provider_instance_id
            || self.claim_id
                != claim_id(
                    &self.binding,
                    &self.accepted_graph_nonce,
                    &row.effect_id,
                    row.attempt_count,
                )?
        {
            return Err(REJECTED.into());
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
        } else if self.nonce != self.claim_id
            || self.issued_at_ms != row.observed_at_ms
            || self.issuer_key_id.is_some()
            || self.preparation_receipt_digest.is_some()
        {
            return Err(REJECTED.into());
        }
        Ok(())
    }
    pub fn matches(&self, prepared: &Self, issuer: &str, payload_digest: &str) -> bool {
        let mut selected = self.clone();
        selected.issuer_key_id = None;
        selected.preparation_receipt_digest = None;
        selected.nonce = prepared.nonce.clone();
        selected.issued_at_ms = prepared.issued_at_ms;
        selected.expires_at_ms = prepared.expires_at_ms;
        self.issuer_key_id.as_deref() == Some(issuer)
            && self.preparation_receipt_digest.as_deref() == Some(payload_digest)
            && self.issued_at_ms >= prepared.issued_at_ms
            && self.expires_at_ms <= prepared.expires_at_ms
            && selected == *prepared
    }
}
