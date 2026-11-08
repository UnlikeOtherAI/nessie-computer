//! A distinct five-second total effect. No provider/session reservation fields.
use crate::{
    custody::{valid_nonce, Generation, REJECTED},
    execution::{digest, identifier, Binding, Custody},
    execution_secret_plan::{account, op_reference, Selection, Slot},
};
use serde::{Deserialize, Serialize};
pub const DOMAIN: &str = "nessie.t3.execution.secret-read.v1";
pub const PREPARATION_DOMAIN: &str = "nessie.t3.execution.secret-read-preparation.v1";
pub const MAX_VALUE_BYTES: u32 = 65536;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    pub resource_id: String,
    pub resource_generation: String,
    pub settings_identity: String,
    pub settings_digest: String,
    pub provider_instance_id: String,
    pub provider_config_digest: String,
    pub secret_providers_digest: String,
    pub credential_home_reference_id: String,
    pub custody: Custody,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    pub evidence: Evidence,
    pub selection: Selection,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recipient {
    pub slot_id: String,
    pub generation: Generation,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tool {
    pub kind: String,
    pub installation_digest: String,
    pub image_digest: String,
    pub version: String,
    pub account: String,
    pub owner_profile_identity: String,
    pub environment_digest: String,
    pub process_descriptor_digest: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Read {
    pub version: u32,
    pub action: String,
    pub binding: Binding,
    pub accepted_graph_nonce: String,
    pub plan_id: String,
    pub plan_digest: String,
    pub read_id: String,
    pub evidence: Evidence,
    pub slot: Slot,
    pub recipient: Recipient,
    pub tool: Tool,
    pub max_value_bytes: u32,
    pub nonce: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuer_key_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preparation_receipt_digest: Option<String>,
}
impl Read {
    pub fn validate(&self, now: u64, admission: bool) -> Result<(), String> {
        self.binding.validate(false)?;
        let e = &self.evidence;
        if self.version != 1
            || self.action != "selected-provider-secret-read"
            || self.tool.kind != "one_password"
            || self.max_value_bytes != MAX_VALUE_BYTES
            || self.expires_at_ms <= now
            || self.issued_at_ms > now
            || self.expires_at_ms <= self.issued_at_ms
            || self.expires_at_ms - self.issued_at_ms > 5000
            || self.expires_at_ms > 9_007_199_254_740_991
            || self.slot.index > 255
            || !account(&self.tool.account)
            || !op_reference(&self.slot.reference.reference)
            || !identifier(&self.slot.name)
            || !identifier(&self.slot.reference.provider)
            || !identifier(&self.tool.version)
            || !identifier(&self.tool.owner_profile_identity)
            || !digest(&self.tool.environment_digest)
            || !identifier(&e.settings_identity)
            || ![
                &self.accepted_graph_nonce,
                &self.plan_id,
                &self.read_id,
                &self.nonce,
                &e.resource_id,
                &e.settings_digest,
                &e.credential_home_reference_id,
                &self.recipient.slot_id,
            ]
            .into_iter()
            .all(|v| valid_nonce(v))
            || ![
                &self.plan_digest,
                &e.resource_generation,
                &e.provider_config_digest,
                &e.secret_providers_digest,
                &self.tool.installation_digest,
                &self.tool.image_digest,
                &self.tool.process_descriptor_digest,
            ]
            .into_iter()
            .all(|v| digest(v))
            || self.binding.provider_instance_id != e.provider_instance_id
            || self.binding.credential_binding_id != e.credential_home_reference_id
            || self.recipient.generation != e.custody.runtime
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
        } else if self.nonce != self.read_id
            || self.issuer_key_id.is_some()
            || self.preparation_receipt_digest.is_some()
        {
            return Err(REJECTED.into());
        }
        Ok(())
    }
    /// Permanent logical read identity: changing plan/read/recipient never renews it.
    pub fn slot_claim(&self) -> Result<String, String> {
        let digest = crate::execution::value_digest(&serde_json::json!({
            "executorId":self.binding.executor_id,"sourceEvidenceDigest":self.binding.source_evidence_digest,
            "acceptedGraphNonce":self.accepted_graph_nonce,"environmentIndex":self.slot.index
        }))?;
        Ok(digest.strip_prefix("sha256:").ok_or(REJECTED)?.into())
    }
    pub fn matches_preparation(&self, original: &Read) -> bool {
        let mut selected = self.clone();
        selected.issuer_key_id = None;
        selected.preparation_receipt_digest = None;
        selected.nonce = original.nonce.clone();
        selected.issued_at_ms = original.issued_at_ms;
        selected.expires_at_ms = original.expires_at_ms;
        selected == *original
            && self.issued_at_ms >= original.issued_at_ms
            && self.expires_at_ms <= original.expires_at_ms
    }
}
