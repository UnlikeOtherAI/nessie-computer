//! Unsigned facts about one complete original legacy-shell action. No grant.
use crate::{custody::REJECTED, execution::canonical};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const MAX_TARGETS: usize = 256;
pub const MAX_BYTES: usize = 4 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub action: String,
    pub thread_id: String,
    pub project_id: String,
}
impl Target {
    pub fn validate(&self) -> Result<(), String> {
        if !["repair", "import"].contains(&self.action.as_str())
            || [&self.thread_id, &self.project_id].iter().any(|id| {
                id.is_empty()
                    || id.len() > 256
                    || id.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
            })
        {
            return Err(REJECTED.into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    pub version: u32,
    pub observed_at_ms: u64,
    pub plan_digest: String,
    pub targets: Vec<Target>,
}
/// The service alone assembles this data using fixed reads from its held file.
/// This pure encoder never accepts caller plans as independent observations.
pub fn observe(
    inputs: Value,
    targets: Vec<Target>,
    observed_at_ms: u64,
) -> Result<Observation, String> {
    if targets.len() > MAX_TARGETS || observed_at_ms > 9_007_199_254_740_991 {
        return Err(REJECTED.into());
    }
    for target in &targets {
        target.validate()?;
    }
    let data = serde_json::json!({"inputs":inputs,"targets":targets});
    let encoded = canonical(&data)?;
    if encoded.len() > MAX_BYTES {
        return Err(REJECTED.into());
    }
    let digest =
        Sha256::digest(format!("[\"nessie.t3.legacy-shell-plan.v1\",{encoded}]").as_bytes());
    Ok(Observation {
        version: 1,
        observed_at_ms,
        plan_digest: format!("sha256:{digest:x}"),
        targets,
    })
}
