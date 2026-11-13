//! Actual read-only Windows SQLite component, not protected graph admission.
use super::super::super::lineage as reader;
use super::*;
use nessie_windows_common::{
    execution::{Binding, Graph},
    execution_command_lineage::{self as commands, Capture, Edge},
};

fn data() -> Value {
    serde_json::from_str(include_str!(
        "../../test/t3-session-runtime/fixtures/original-command-lineage.json"
    ))
    .unwrap()
}
fn graph() -> Graph {
    let f = data();
    // Metadata selector only: none of these component calls authenticates a graph.
    Graph {
        version: 1,
        nonce: "a".repeat(64),
        source_revision: "b".repeat(40),
        targets: Vec::new(),
        issued_at_ms: 0,
        expires_at_ms: 5000,
        binding: Binding {
            executor_id: "fixture".into(),
            environment_id: "environment".into(),
            thread_id: f["thread"].as_str().unwrap().into(),
            provider_instance_id: f["provider"].as_str().unwrap().into(),
            connection_epoch: "epoch".into(),
            runtime_generation: "runtime".into(),
            correlation_id: "correlation".into(),
            command_id: f["parent"].as_str().unwrap().into(),
            request_sha256: format!("sha256:{}", "c".repeat(64)),
            relay_hmac: format!("hmac-sha256:{}", "d".repeat(64)),
            actor_reference: format!("sha256:{}", "e".repeat(64)),
            initiation_reference: format!("sha256:{}", "f".repeat(64)),
            source_evidence_digest: None,
            source_root_key: "source".into(),
            source_generation: "capture".into(),
            driver: "codex".into(),
            continuation_home_key: "continuation".into(),
            history_home_key: "history".into(),
            credential_binding_id: "credential".into(),
        },
    }
}
fn fixture() -> Fixture {
    let f = Fixture::new(true);
    f.writer().exec("CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, event_id TEXT,
        aggregate_kind TEXT, stream_id TEXT, stream_version INTEGER, event_type TEXT, occurred_at TEXT, command_id TEXT,
        causation_event_id TEXT, correlation_id TEXT, actor_kind TEXT, payload_json TEXT, metadata_json TEXT, application_event_version INTEGER)");
    let d = data();
    for (table, rows) in [
        ("orchestration_command_receipts", "receipts"),
        ("orchestration_events", "events"),
    ] {
        for row in d[rows].as_array().unwrap() {
            if row["command_id"] == f.data["row"]["command_id"] && rows == "receipts" {
                continue;
            }
            let fields = row.as_object().unwrap();
            f.writer().exec(&format!(
                "INSERT INTO {table} ({}) VALUES ({})",
                fields.keys().cloned().collect::<Vec<_>>().join(","),
                fields.values().map(literal).collect::<Vec<_>>().join(",")
            ));
        }
    }
    f
}
fn accepted(f: &Fixture) -> (Capture, commands::AcceptedInitial) {
    let d = data();
    let g = graph();
    let mut capture = Capture::new(
        "graph-digest".into(),
        g.binding.command_id.clone(),
        g.binding.thread_id.clone(),
        g.binding.provider_instance_id.clone(),
        u64::MAX,
        0,
    );
    let initial: Edge = serde_json::from_value(d["edges"][0].clone()).unwrap();
    capture.record(&initial, None, None, 0).unwrap();
    let proof = reader::accept_initial(
        &f.main,
        &f.owner,
        &g,
        capture.initial().unwrap(),
        d["run"].as_str().unwrap(),
    )
    .unwrap();
    capture
        .record(
            &serde_json::from_value(d["edges"][1].clone()).unwrap(),
            Some(proof.clone()),
            None,
            0,
        )
        .unwrap();
    (capture, proof)
}
fn complete(f: &Fixture) -> commands::Evidence {
    let d = data();
    let g = graph();
    let (mut capture, proof) = accepted(f);
    let edge: Edge = serde_json::from_value(d["edges"][2].clone()).unwrap();
    capture.record(&edge, None, None, 0).unwrap();
    let release = reader::accept_release(
        &f.main,
        &f.owner,
        &g,
        capture.initial().unwrap(),
        &proof,
        d["edges"][2]["commandId"].as_str().unwrap(),
    )
    .unwrap();
    capture
        .record(
            &serde_json::from_value(d["edges"][3].clone()).unwrap(),
            None,
            Some(release),
            0,
        )
        .unwrap();
    capture.evidence(0).unwrap()
}
#[test]
fn bound_pending_read_matches_actual_receipts_run_events_and_original_full_row_without_writes() {
    let f = fixture();
    let evidence = complete(&f);
    let before = f
        .writer()
        .scalar("SELECT status || ':' || attempt_count FROM orchestration_v2_effect_outbox");
    let bound = reader::observe(&f.main, &f.owner, &graph(), evidence, "effect:雪:one")
        .unwrap()
        .unwrap();
    assert_eq!(bound.observation.row_digest, f.data["rowDigest"]);
    assert_eq!(bound.original.parent_command_id, data()["parent"]);
    let wire = serde_json::to_string(&bound).unwrap();
    assert!(!wire.contains("payload_json"));
    assert!(!wire.contains("PRIVATE_ROW_CANARY"));
    assert_eq!(
        f.writer()
            .scalar("SELECT status || ':' || attempt_count FROM orchestration_v2_effect_outbox"),
        before
    );
}
#[test]
fn foreign_run_or_command_stays_unrecognized_and_changed_acceptance_refuses() {
    for mode in 0..4 {
        let f = fixture();
        let evidence = complete(&f);
        f.writer().exec(match mode {
            0 => "UPDATE orchestration_v2_effect_outbox SET payload_json = '{\"type\":\"provider-turn.start\",\"runId\":\"foreign\"}'",
            1 => "UPDATE orchestration_v2_effect_outbox SET command_id = 'foreign'",
            2 => "UPDATE orchestration_command_receipts SET accepted_at = '2001-01-01T00:00:00.000Z' WHERE command_type = 'message.dispatch'",
            _ => "UPDATE orchestration_events SET correlation_id = 'parent:actual:launch' WHERE event_type = 'run.updated'",
        });
        let result = reader::observe(&f.main, &f.owner, &graph(), evidence, "effect:雪:one");
        if mode < 2 {
            assert!(result.unwrap().is_none());
        } else {
            assert!(result.is_err());
        }
        assert_eq!(
            f.writer()
                .scalar("SELECT attempt_count FROM orchestration_v2_effect_outbox"),
            "2"
        );
    }
}
#[test]
fn missing_duplicate_pruned_ambiguous_or_mismatched_initial_events_cannot_attest_acceptance() {
    for mode in 0..7 {
        let f = fixture();
        let d = data();
        f.writer().exec(match mode {
            0 => "DELETE FROM orchestration_events WHERE event_type = 'run.created'",
            1 => "INSERT INTO orchestration_events SELECT sequence+10, event_id, aggregate_kind, stream_id, stream_version+10, event_type, occurred_at,
                command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json, application_event_version
                FROM orchestration_events WHERE event_type = 'run.created'",
            2 => "UPDATE orchestration_events SET metadata_json = '{\"runId\":\"wrong\",\"runId\":\"run:雪:one\"}' WHERE event_type = 'run.created'",
            3 => "UPDATE orchestration_events SET payload_json = json_set(payload_json, '$.userMessageId', 'foreign') WHERE event_type = 'run.created'",
            4 => "UPDATE orchestration_command_receipts SET status = 'rejected' WHERE command_type = 'thread.create'",
            5 => "ALTER TABLE orchestration_events ADD COLUMN hidden_value TEXT GENERATED ALWAYS AS ('unrecognized') VIRTUAL",
            _ => "UPDATE orchestration_events SET sequence = 1 WHERE event_type = 'run.created'",
        });
        let first = commands::Initial {
            command_id: d["edges"][0]["commandId"].as_str().unwrap().into(),
            message_id: d["message"].as_str().unwrap().into(),
        };
        assert!(reader::accept_initial(&f.main, &f.owner, &graph(), &first, d["run"].as_str().unwrap()).is_err());
    }
}
#[test]
fn release_run_event_must_follow_the_actual_initial_receipt_sequence() {
    let f = fixture();
    let d = data();
    let (capture, initial) = accepted(&f);
    f.writer()
        .exec("UPDATE orchestration_events SET sequence = 4 WHERE event_type = 'run.updated'");
    assert!(reader::accept_release(
        &f.main,
        &f.owner,
        &graph(),
        capture.initial().unwrap(),
        &initial,
        d["edges"][2]["commandId"].as_str().unwrap()
    )
    .is_err());
}
