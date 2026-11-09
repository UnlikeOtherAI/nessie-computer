//! Unsigned facts about the original complete global process-loss transition.
//! No lifecycle permission, source authority or mutation is issued here.
use crate::{custody::REJECTED, execution_outbox_row::Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const MAX_ROWS: usize = 256;
pub const MAX_ROW_BYTES: usize = 1024 * 1024;
pub const PROCESS_BOUND: &[&str] = &[
    "provider-turn.start",
    "provider-turn.interrupt",
    "provider-turn.steer",
    "provider-turn.restart",
    "runtime-request.respond",
];
pub const REPLAY_SAFE: &[&str] = &[
    "provider-runtime.continue",
    "provider-session.detach",
    "provider-thread.rollback",
    "checkpoint.capture",
    "scheduled-tasks.cleanup",
    "terminal.cleanup",
    "preview.cleanup",
    "attachment.cleanup",
    "thread-title.generate",
    "delegated-tasks.stop",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    pub version: u32,
    pub observed_at_ms: u64,
    pub plan_digest: String,
    pub row_count: usize,
    pub cancelled: usize,
    pub requeued: usize,
}

pub fn encoded_row_size(value: &Value) -> Result<usize, String> {
    Ok(Row::decode(value.clone())?.encoded()?.len())
}

/// Callers obtain every selected row in binary effect-id order from one held
/// readonly snapshot. No truncation, command/thread filter or JSON decoding of
/// effect payloads replaces the original structural recovery classification.
pub fn observe(rows: Vec<Value>, observed_at_ms: u64) -> Result<Observation, String> {
    if rows.len() > MAX_ROWS || observed_at_ms > 9_007_199_254_740_991 {
        return Err(REJECTED.into());
    }
    let mut encoded = Vec::new();
    let mut bytes = 0;
    let mut cancelled = 0;
    let mut previous: Option<String> = None;
    for value in rows {
        let row = Row::decode(value)?;
        // Match the original ordered fourteen-field JSON byte budget.
        bytes += row.encoded()?.len();
        if bytes > MAX_ROW_BYTES || previous.as_ref().is_some_and(|id| id >= &row.effect_id) {
            return Err(REJECTED.into());
        }
        let transition = if PROCESS_BOUND.contains(&row.effect_type.as_str()) && ["pending", "running"].contains(&row.status.as_str()) {
            cancelled += 1;
            "cancel"
        } else if REPLAY_SAFE.contains(&row.effect_type.as_str()) && row.status == "running" {
            "requeue"
        } else {
            return Err(REJECTED.into());
        };
        encoded.push(json!([transition, row.digest()?]));
        previous = Some(row.effect_id);
    }
    let row_count = encoded.len();
    let bytes = serde_json::to_vec(&json!(["nessie.t3.process-loss-plan.v1", encoded])).map_err(|_| REJECTED)?;
    Ok(Observation {
        version: 1,
        observed_at_ms,
        plan_digest: format!("sha256:{:x}", Sha256::digest(bytes)),
        row_count,
        cancelled,
        requeued: row_count - cancelled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../test/t3-session-runtime/fixtures/process-loss-plan.json")).unwrap()
    }
    #[test]
    fn process_loss_encoding_matches_the_original_complete_row_plan_without_disclosing_values() {
        let fixture = fixture();
        let rows = fixture["rows"].as_array().unwrap().clone();
        let observation = observe(rows.clone(), 1_794_182_400_000).unwrap();
        assert_eq!(observation.plan_digest, fixture["planDigest"].as_str().unwrap());
        assert_eq!((observation.row_count, observation.cancelled, observation.requeued), (2, 1, 1));
        assert_eq!(serde_json::to_value(PROCESS_BOUND).unwrap(), fixture["processBoundTypes"]);
        assert_eq!(serde_json::to_value(REPLAY_SAFE).unwrap(), fixture["replaySafeTypes"]);
        let wire = serde_json::to_string(&observation).unwrap();
        assert!(!wire.contains("PRIVATE_"));
        assert!(!wire.contains("commandId"));
        assert!(!wire.contains("payload_json"));
        for column in crate::execution_outbox_row::ROW_COLUMNS {
            if ["effect_id", "effect_type", "status", "attempt_count"].contains(column) {
                continue;
            }
            let mut changed = rows.clone();
            changed[0][*column] = json!("a changed physical field");
            assert_ne!(observe(changed, 1_794_182_400_000).unwrap().plan_digest, observation.plan_digest);
        }
        let mut changed = rows;
        changed[0]["payload_json"] = json!("malformed payload remains opaque to original recovery");
        assert!(observe(changed, 1_794_182_400_000).is_ok());
    }
    #[test]
    fn process_loss_observation_refuses_partial_classification_ambiguous_rows_duplicates_and_reordering() {
        let rows = fixture()["rows"].as_array().unwrap().clone();
        for mutation in 0..9 {
            let mut changed = rows.clone();
            match mutation {
                0 => changed.reverse(),
                1 => changed[1] = changed[0].clone(),
                2 => changed[0]["effect_type"] = json!("unknown"),
                3 => changed[0]["status"] = json!("failed"),
                4 => changed[1]["status"] = json!("pending"),
                5 => {
                    changed[0].as_object_mut().unwrap().remove("lease_expires_at");
                }
                6 => changed[0]["extra"] = json!("not a physical column"),
                7 => changed[0]["attempt_count"] = json!(9_007_199_254_740_992_u64),
                _ => changed[0]["attempt_count"] = json!(-1),
            }
            assert!(observe(changed, 1_794_182_400_000).is_err());
        }
        let empty = observe(Vec::new(), 1_794_182_400_000).unwrap();
        assert_eq!((empty.row_count, empty.cancelled, empty.requeued), (0, 0, 0));
        assert_ne!(empty.plan_digest, observe(rows, 1_794_182_400_000).unwrap().plan_digest);
    }
    #[test]
    fn process_loss_bounds_refuse_the_whole_plan_instead_of_truncating() {
        let row = fixture()["rows"][0].clone();
        let rows: Vec<_> = (0..MAX_ROWS)
            .map(|i| {
                let mut row = row.clone();
                row["effect_id"] = json!(format!("effect-{i:04}"));
                row
            })
            .collect();
        assert_eq!(observe(rows.clone(), 1).unwrap().row_count, MAX_ROWS);
        let mut overflow = rows;
        let mut last = row.clone();
        last["effect_id"] = json!("last");
        overflow.push(last);
        assert!(observe(overflow, 1).is_err());
        let mut large = row;
        large["payload_json"] = json!("x".repeat(MAX_ROW_BYTES));
        assert!(observe(vec![large], 1).is_err());
    }
}
