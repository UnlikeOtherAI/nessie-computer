//! Physical inputs of the pinned original runtime-recovery SELECTs. Facts only;
//! no lifecycle permission, mutation admission or caller-supplied SQL.
use crate::{custody::REJECTED, execution::identifier};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_ROWS: usize = 16384;
pub const MAX_BYTES: usize = 4 * 1024 * 1024;
pub const SECTIONS: &[&str] = &[
    "attempts",
    "messages",
    "nodes",
    "providerSessions",
    "providerThreads",
    "providerTurns",
    "runs",
    "runtimeRequests",
    "subagents",
    "turnItems",
];
pub const TABLES: &[&str] = &[
    "orchestration_v2_projection_threads",
    "orchestration_v2_projection_runs",
    "orchestration_v2_projection_run_attempts",
    "orchestration_v2_projection_nodes",
    "orchestration_v2_projection_subagents",
    "orchestration_v2_projection_provider_sessions",
    "orchestration_v2_projection_provider_session_bindings",
    "orchestration_v2_projection_provider_threads",
    "orchestration_v2_projection_provider_turns",
    "orchestration_v2_projection_runtime_requests",
    "orchestration_v2_projection_messages",
    "orchestration_v2_projection_turn_items",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    pub version: u32,
    pub observed_at_ms: u64,
    pub thread_id: String,
    pub input_digest: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub query: String,
    pub parameters: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SectionQuery {
    pub section: String,
    pub query: String,
    pub parameters: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Queries {
    pub version: u32,
    pub source_commit: String,
    pub tables: Vec<String>,
    pub thread: Query,
    pub shutdown_selection: Query,
    pub sections: Vec<SectionQuery>,
}
pub fn queries() -> Result<Queries, String> {
    let value: Queries = serde_json::from_str(include_str!("execution_recovery_queries.json"))
        .map_err(|_| REJECTED)?;
    if value.version != 1
        || value.shutdown_selection.parameters != 3
        || value.thread.parameters != 1
        || value.sections.len() != SECTIONS.len()
        || value.source_commit != "25bf84ab07f53f141c20239c63e383823a9d5ea0"
        || value.tables.len() != TABLES.len()
        || value
            .tables
            .iter()
            .any(|table| !TABLES.contains(&table.as_str()))
        || value.tables.windows(2).any(|pair| pair[0] >= pair[1])
        || value
            .sections
            .iter()
            .zip(SECTIONS)
            .any(|(query, expected)| {
                query.section != *expected || query.parameters == 0 || query.parameters > 64
            })
    {
        return Err(REJECTED.into());
    }
    Ok(value)
}
pub fn observe(
    thread: &str,
    payload: &str,
    rows: &[(String, String)],
    now: u64,
) -> Result<Observation, String> {
    if !identifier(thread)
        || rows.len() > MAX_ROWS
        || now > 9_007_199_254_740_991
        || rows
            .iter()
            .any(|(section, _)| !SECTIONS.contains(&section.as_str()))
        || rows.windows(2).any(|pair| pair[0].0 > pair[1].0)
    {
        return Err(REJECTED.into());
    }
    let value = serde_json::to_vec(&(
        "nessie.t3.runtime-recovery-inputs.v1",
        thread,
        payload,
        rows,
    ))
    .map_err(|_| REJECTED)?;
    if value.len() > MAX_BYTES {
        return Err(REJECTED.into());
    }
    Ok(Observation {
        version: 1,
        observed_at_ms: now,
        thread_id: thread.into(),
        input_digest: format!("sha256:{:x}", Sha256::digest(value)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_query_data_has_only_the_complete_pinned_section_set() {
        let value = queries().unwrap();
        assert!(value
            .sections
            .iter()
            .all(|query| !query.query.contains("${")
                && query.query.matches('?').count() == query.parameters));
    }
    #[test]
    fn recovery_input_digest_retains_exact_text_order_and_complete_sections() {
        let rows = vec![("runs".into(), "{\"id\":\"run:雪\"}".into())];
        let original = observe("thread:雪", "{ \"id\": \"thread:雪\" }", &rows, 1).unwrap();
        assert_ne!(
            original.input_digest,
            observe("thread:雪", "{\"id\":\"thread:雪\"}", &rows, 1)
                .unwrap()
                .input_digest
        );
        let changed = vec![("runs".into(), "{\"id\":\"replacement\"}".into())];
        assert_ne!(
            original.input_digest,
            observe("thread:雪", "{ \"id\": \"thread:雪\" }", &changed, 1)
                .unwrap()
                .input_digest
        );
        assert!(observe("thread", "{}", &[("private".into(), "{}".into())], 1).is_err());
        assert!(observe(
            "thread",
            "{}",
            &[
                ("runs".into(), "{}".into()),
                ("attempts".into(), "{}".into())
            ],
            1
        )
        .is_err());
        assert!(observe("thread", &"x".repeat(MAX_BYTES), &[], 1).is_err());
    }
    #[test]
    fn recovery_input_digest_matches_actual_original_sqlite_fixture() {
        let value: serde_json::Value = serde_json::from_str(include_str!(
            "../../test/t3-session-runtime/fixtures/recovery-projection-inputs.json"
        ))
        .unwrap();
        let rows: Vec<(String, String)> =
            serde_json::from_value(value["rawSections"].clone()).unwrap();
        let actual = observe(
            value["threadId"].as_str().unwrap(),
            value["rawThread"].as_str().unwrap(),
            &rows,
            1,
        )
        .unwrap();
        assert_eq!(actual.input_digest, value["inputDigest"].as_str().unwrap());
    }
}
