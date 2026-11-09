//! Metadata from an observed SQL row. Parsing these facts grants no authority.
use crate::{
    custody::REJECTED,
    execution::{identifier, value_digest},
    execution_json,
};
use serde::{Deserialize, Serialize};
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
pub const RECEIPT_COLUMNS: &[&str] = &[
    "command_id",
    "aggregate_kind",
    "aggregate_id",
    "accepted_at",
    "result_sequence",
    "status",
    "error",
    "command_type",
];
fn metadata(value: &str) -> bool {
    identifier(value) && value.len() <= 256 && !value.chars().any(char::is_control)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Row {
    effect_id: String,
    command_id: String,
    thread_id: String,
    effect_type: String,
    payload_json: String,
    status: String,
    attempt_count: i64,
    available_at: String,
    lease_owner: Option<String>,
    lease_expires_at: Option<String>,
    created_at: String,
    updated_at: String,
    completed_at: Option<String>,
    last_error: Option<String>,
}
impl Row {
    fn digest(&self) -> Result<String, String> {
        let bytes = serde_json::to_vec(&json!([
            "nessie.t3.pending-effect-row.v1",
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
        ]))
        .map_err(|_| REJECTED)?;
        Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommandReceipt {
    command_id: String,
    aggregate_kind: String,
    aggregate_id: String,
    accepted_at: String,
    result_sequence: i64,
    status: String,
    error: Option<String>,
    command_type: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    pub version: u32,
    pub observed_at_ms: u64,
    pub effect_id: String,
    pub command_id: String,
    pub thread_id: String,
    pub effect_type: String,
    pub attempt_count: i64,
    pub available_at: String,
    pub row_digest: String,
    pub payload_digest: String,
    pub command_type: String,
    pub accepted_at: String,
    pub result_sequence: i64,
    pub receipt_digest: String,
}
/// Private SQL callers must obtain both raw values from one actual read snapshot.
/// Acceptance is a durable fact, not proof of this graph's parent-command edge.
pub fn observe(
    row: Value,
    receipt: Value,
    expected_thread: &str,
    expected_effect: &str,
    observed_at_ms: u64,
) -> Result<Observation, String> {
    if row.as_object().is_none_or(|row| row.len() != ROW_COLUMNS.len())
        || receipt
            .as_object()
            .is_none_or(|receipt| receipt.len() != RECEIPT_COLUMNS.len())
    {
        return Err(REJECTED.into());
    }
    let receipt_digest = value_digest(&receipt)?;
    let command: CommandReceipt = serde_json::from_value(receipt).map_err(|_| REJECTED)?;
    let row: Row = serde_json::from_value(row).map_err(|_| REJECTED)?;
    if row.effect_id != expected_effect
        || row.thread_id != expected_thread
        || row.status != "pending"
        || !(0..9_007_199_254_740_991).contains(&row.attempt_count)
        || !metadata(&row.effect_id)
        || !metadata(&row.command_id)
        || !metadata(&row.thread_id)
        || !metadata(&row.effect_type)
        || !metadata(&row.available_at)
        || !metadata(&command.accepted_at)
        || !metadata(&command.command_type)
        || command.command_id != row.command_id
        || command.aggregate_kind != "thread"
        || command.aggregate_id != row.thread_id
        || command.status != "accepted"
        || command.error.is_some()
        || !(0..=9_007_199_254_740_991).contains(&command.result_sequence)
    {
        return Err(REJECTED.into());
    }
    let payload = execution_json::parse(row.payload_json.as_bytes())?;
    if !payload.is_object() || payload["type"] != row.effect_type {
        return Err(REJECTED.into());
    }
    Ok(Observation {
        version: 1,
        observed_at_ms,
        effect_id: row.effect_id.clone(),
        command_id: row.command_id.clone(),
        thread_id: row.thread_id.clone(),
        effect_type: row.effect_type.clone(),
        attempt_count: row.attempt_count,
        available_at: row.available_at.clone(),
        row_digest: row.digest()?,
        payload_digest: format!("sha256:{:x}", Sha256::digest(row.payload_json.as_bytes())),
        command_type: command.command_type,
        accepted_at: command.accepted_at,
        result_sequence: command.result_sequence,
        receipt_digest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../test/t3-session-runtime/fixtures/pending-effect-row.json"
        ))
        .unwrap()
    }
    fn observed(fixture: &Value) -> Result<Observation, String> {
        observe(
            fixture["row"].clone(),
            fixture["receipt"].clone(),
            "thread:雪:one",
            "effect:雪:one",
            1_794_182_400_000,
        )
    }
    #[test]
    fn pending_effect_encoding_matches_original_sql_all_fourteen_fields_without_disclosing_values() {
        let fixture = fixture();
        let observation = observed(&fixture).unwrap();
        assert_eq!(observation.row_digest, fixture["rowDigest"].as_str().unwrap());
        let wire = serde_json::to_string(&observation).unwrap();
        assert!(!wire.contains("PRIVATE_ROW_CANARY"));
        assert!(!wire.contains("runId"));
        assert!(!wire.contains("parentCommandId"));
        let mut changed = fixture.clone();
        changed["row"]["lease_expires_at"] = Value::Null;
        assert_ne!(observed(&changed).unwrap().row_digest, observation.row_digest);
    }
    #[test]
    fn pending_effect_facts_refuse_ambiguous_json_missing_columns_wrong_receipts_and_nonpending_rows() {
        let fixture = fixture();
        for mutation in 0..7 {
            let mut changed = fixture.clone();
            match mutation {
                0 => {
                    changed["row"].as_object_mut().unwrap().remove("lease_expires_at");
                }
                1 => changed["row"]["payload_json"] = json!("{\"type\":\"wrong\",\"type\":\"provider-turn.start\"}"),
                2 => changed["receipt"]["aggregate_id"] = json!("foreign-thread"),
                3 => changed["receipt"]["status"] = json!("rejected"),
                4 => changed["row"]["status"] = json!("running"),
                5 => changed["row"]["extra"] = json!("caller asserted proof"),
                _ => changed["row"]["attempt_count"] = json!(-1),
            }
            assert!(observed(&changed).is_err());
        }
    }
}
