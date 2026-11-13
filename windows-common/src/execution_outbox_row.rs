//! Exact physical original outbox row encoding, shared by readonly observers.
//! No raw row is serialized into an observation or accepted as authority.
use crate::custody::REJECTED;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
pub const ROW_COLUMNS: &[&str] = &[
    "effect_id",
    "command_id",
    "thread_id",
    "effect_type",
    "payload_json",
    "status",
    "attempt_count",
    "available_at",
    "lease_owner",
    "lease_expires_at",
    "created_at",
    "updated_at",
    "completed_at",
    "last_error",
];
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Row {
    pub(crate) effect_id: String,
    pub(crate) command_id: String,
    pub(crate) thread_id: String,
    pub(crate) effect_type: String,
    pub(crate) payload_json: String,
    pub(crate) status: String,
    pub(crate) attempt_count: i64,
    pub(crate) available_at: String,
    pub(crate) lease_owner: Option<String>,
    pub(crate) lease_expires_at: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) completed_at: Option<String>,
    pub(crate) last_error: Option<String>,
}
impl Row {
    pub(crate) fn decode(value: Value) -> Result<Self, String> {
        if value.as_object().is_none_or(|row| row.len() != ROW_COLUMNS.len()) {
            return Err(REJECTED.into());
        }
        let row: Self = serde_json::from_value(value).map_err(|_| REJECTED)?;
        if !(0..=9_007_199_254_740_991).contains(&row.attempt_count) {
            return Err(REJECTED.into());
        }
        Ok(row)
    }
    fn fields(&self) -> Value {
        json!([
            self.effect_id,
            self.command_id,
            self.thread_id,
            self.effect_type,
            self.payload_json,
            self.status,
            self.attempt_count,
            self.available_at,
            self.lease_owner,
            self.lease_expires_at,
            self.created_at,
            self.updated_at,
            self.completed_at,
            self.last_error
        ])
    }
    pub(crate) fn encoded(&self) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&self.fields()).map_err(|_| REJECTED.into())
    }
    pub(crate) fn digest(&self) -> Result<String, String> {
        let mut fields = self.fields().as_array().ok_or(REJECTED)?.clone();
        fields.insert(0, json!("nessie.t3.pending-effect-row.v1"));
        let bytes = serde_json::to_vec(&fields).map_err(|_| REJECTED)?;
        Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
    }
}
