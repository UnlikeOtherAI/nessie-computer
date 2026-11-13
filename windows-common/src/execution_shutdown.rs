//! Independent metadata selection for the pinned original shutdown action.
//! Source: ShutdownPreparation/RestartContinuation at 25bf84ab (MIT).
use crate::{
    custody::REJECTED,
    execution::{digest, identifier},
    execution_codec::trimmed,
    execution_json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const MAX_TARGETS: usize = 256;
pub const AUTHORITY_DOMAIN: &str = "nessie.t3.shutdown-authority.v1";
pub struct Policy {
    pub enabled: bool,
    pub overrides: BTreeMap<String, bool>,
}
impl Policy {
    pub fn read(bytes: &[u8]) -> Result<Self, String> {
        let value = execution_json::parse(bytes)?;
        if !value.is_object() {
            return Err(REJECTED.into());
        }
        let enabled = match value.get("continueThreadsAfterServerUpdate") {
            None => true,
            Some(value) => value.as_bool().ok_or(REJECTED)?,
        };
        let mut overrides = BTreeMap::new();
        if let Some(raw) = value.get("projectSettingsOverrides") {
            for (project, entry) in raw.as_object().ok_or(REJECTED)? {
                if !entry.is_object() {
                    return Err(REJECTED.into());
                }
                let project = trimmed(&json!(project))?;
                if let Some(enabled) = entry.get("continueThreadsAfterServerUpdate") {
                    if overrides
                        .insert(project, enabled.as_bool().ok_or(REJECTED)?)
                        .is_some()
                    {
                        return Err(REJECTED.into());
                    }
                }
            }
        }
        Ok(Self { enabled, overrides })
    }
    pub fn encoded(&self) -> Value {
        json!([self.enabled, self.overrides.iter().collect::<Vec<_>>()])
    }
    pub fn selection_parameters(&self) -> Result<[String; 3], String> {
        let ids = |enabled| {
            serde_json::to_string(
                &self
                    .overrides
                    .iter()
                    .filter(|(_, value)| **value == enabled)
                    .map(|(key, _)| key)
                    .collect::<Vec<_>>(),
            )
            .map_err(|_| REJECTED.to_string())
        };
        Ok([
            if self.enabled { "all" } else { "selected" }.into(),
            ids(true)?,
            ids(false)?,
        ])
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub thread_id: String,
    pub project_id: String,
    pub input_digest: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Effect {
    pub thread_id: String,
    pub source_run_id: String,
    pub effect_id: String,
    pub command_id: String,
    pub existing_row_digest: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    pub version: u32,
    pub observed_at_ms: u64,
    pub selection_at_ms: u64,
    pub authority_digest: String,
    pub targets: Vec<Target>,
    pub effects: Vec<Effect>,
}
pub fn observe(
    policy: &Policy,
    targets: Vec<Target>,
    effects: Vec<Effect>,
    observed_at_ms: u64,
    selection_at_ms: u64,
) -> Result<Observation, String> {
    if targets.len() > MAX_TARGETS
        || effects.len() > targets.len()
        || observed_at_ms < selection_at_ms
        || observed_at_ms >= selection_at_ms.saturating_add(5000)
        || targets.iter().any(|t| {
            !identifier(&t.thread_id) || !identifier(&t.project_id) || !digest(&t.input_digest)
        })
        || targets
            .iter()
            .enumerate()
            .any(|(i, t)| targets[..i].iter().any(|v| v.thread_id == t.thread_id))
        || effects.iter().any(|e| {
            !targets.iter().any(|t| t.thread_id == e.thread_id)
                || e.effect_id != format!("effect:restart-continuation:{}", e.source_run_id)
                || e.command_id != format!("command:restart-prepare:{}", e.source_run_id)
                || e.existing_row_digest
                    .as_deref()
                    .is_some_and(|value| !digest(value))
        })
    {
        return Err(REJECTED.into());
    }
    let fields = json!([
        selection_at_ms,
        policy.encoded(),
        targets
            .iter()
            .map(|t| json!([t.thread_id, t.project_id, t.input_digest]))
            .collect::<Vec<_>>(),
        effects
            .iter()
            .map(|e| json!([
                e.thread_id,
                e.source_run_id,
                e.effect_id,
                e.command_id,
                e.existing_row_digest
            ]))
            .collect::<Vec<_>>()
    ]);
    let bytes = serde_json::to_vec(&json!([AUTHORITY_DOMAIN, fields])).map_err(|_| REJECTED)?;
    Ok(Observation {
        version: 1,
        observed_at_ms,
        selection_at_ms,
        authority_digest: format!("sha256:{:x}", Sha256::digest(bytes)),
        targets,
        effects,
    })
}

pub fn bind_existing(effect: &mut Effect, value: Option<Value>) -> Result<(), String> {
    if let Some(value) = value {
        let row = crate::execution_outbox_row::Row::decode(value)?;
        let payload = format!(
            "{{\"type\":\"provider-runtime.continue\",\"sourceRunId\":{}}}",
            serde_json::to_string(&effect.source_run_id).map_err(|_| REJECTED)?
        );
        if row.effect_id != effect.effect_id
            || row.command_id != effect.command_id
            || row.thread_id != effect.thread_id
            || row.effect_type != "provider-runtime.continue"
            || row.payload_json != payload
        {
            return Err(REJECTED.into());
        }
        effect.existing_row_digest = Some(row.digest()?);
    }
    Ok(())
}
#[cfg(test)]
#[path = "execution_shutdown_tests.rs"]
mod tests;

#[path = "execution_shutdown_selection.rs"]
mod selection;
pub use selection::{select, Projection};
