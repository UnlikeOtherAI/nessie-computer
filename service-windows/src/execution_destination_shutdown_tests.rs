//! Actual held SQLite original schema/rows. These tests grant no lifecycle authority.
use super::*;
use crate::execution_resource::destination::shutdown;
use nessie_windows_common::execution_shutdown::{Observation, Policy};
use std::time::{Duration, Instant};
fn data() -> Value {
    serde_json::from_str(include_str!(
        "../../test/t3-session-runtime/fixtures/execution-shutdown.json"
    ))
    .unwrap()
}
fn make_fixture() -> Fixture {
    let fixture = Fixture::new(true);
    fixture
        .writer()
        .exec("DROP TABLE orchestration_v2_effect_outbox");
    let value = data();
    for sql in value["schema"].as_array().unwrap() {
        fixture.writer().exec(sql.as_str().unwrap());
    }
    for (table, rows) in value["tables"].as_object().unwrap() {
        for row in rows.as_array().unwrap() {
            let row = row.as_object().unwrap();
            fixture.writer().exec(&format!(
                "INSERT INTO {table} ({}) VALUES ({})",
                row.keys().map(String::as_str).collect::<Vec<_>>().join(","),
                row.values().map(literal).collect::<Vec<_>>().join(",")
            ));
        }
    }
    fixture
}
fn observe(fixture: &Fixture, value: &Value, expected: &Value) -> Result<Observation, String> {
    let policy = Policy::read(&serde_json::to_vec(&value["settings"]).unwrap()).unwrap();
    snapshot_with_authorizer(
        &fixture.main,
        &fixture.owner,
        shutdown::authorize,
        |connection| {
            shutdown::read_snapshot(
                connection,
                &policy,
                expected["observedAtMs"].as_u64().unwrap(),
                expected["selectionAtMs"].as_u64().unwrap(),
                Instant::now() + Duration::from_millis(5000),
            )
        },
    )
}
#[test]
fn shutdown_actual_snapshot_selects_the_original_complete_action_and_existing_physical_slot() {
    let fixture = make_fixture();
    let value = data();
    let initial = &value["preparation"]["observation"];
    assert_eq!(
        serde_json::to_value(observe(&fixture, &value, initial).unwrap()).unwrap(),
        *initial
    );
    assert_eq!(
        fixture
            .writer()
            .scalar("SELECT count(*) FROM orchestration_v2_effect_outbox"),
        "0"
    );
    let row = value["existingRow"].as_object().unwrap();
    fixture.writer().exec(&format!(
        "INSERT INTO orchestration_v2_effect_outbox ({}) VALUES ({})",
        row.keys().map(String::as_str).collect::<Vec<_>>().join(","),
        row.values().map(literal).collect::<Vec<_>>().join(",")
    ));
    let existing = &value["existingObservation"];
    assert_eq!(
        serde_json::to_value(observe(&fixture, &value, existing).unwrap()).unwrap(),
        *existing
    );
    fixture
        .writer()
        .exec("UPDATE orchestration_v2_effect_outbox SET command_id='foreign'");
    assert!(observe(&fixture, &value, existing).is_err());
}
#[test]
fn shutdown_rejects_changed_inputs_views_triggers_and_expired_actual_observation() {
    let fixture = make_fixture();
    let value = data();
    let expected = &value["preparation"]["observation"];
    fixture
        .writer()
        .exec("UPDATE orchestration_v2_projection_runs SET payload_json=' ' || payload_json");
    assert_ne!(
        observe(&fixture, &value, expected)
            .unwrap()
            .authority_digest,
        expected["authorityDigest"].as_str().unwrap()
    );
    fixture.writer().exec(
        "CREATE TRIGGER outside_shutdown BEFORE INSERT ON orchestration_v2_effect_outbox
        BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    assert!(observe(&fixture, &value, expected).is_err());
    let settings = serde_json::to_vec(&value["settings"]).unwrap();
    assert!(
        shutdown::observe(&fixture.main, &fixture.owner, &settings, 0, Instant::now()).is_err()
    );
    let view = make_fixture();
    view.writer().exec(
        "ALTER TABLE orchestration_v2_projection_threads RENAME TO original_threads;
        CREATE VIEW orchestration_v2_projection_threads AS SELECT * FROM original_threads",
    );
    assert!(observe(&view, &value, expected).is_err());
}
