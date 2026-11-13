//! Actual held Windows SQLite snapshots, not an enrolled lifecycle producer.
use super::*;
use serde_json::json;
fn plan_fixture() -> Value {
    serde_json::from_str(include_str!("../../test/t3-session-runtime/fixtures/process-loss-plan.json")).unwrap()
}
fn insert(fixture: &Fixture, row: &Value) {
    fixture.writer().exec(&format!(
        "INSERT INTO orchestration_v2_effect_outbox ({}) VALUES ({})",
        ROW_COLUMNS.join(","),
        ROW_COLUMNS
            .iter()
            .map(|column| literal(&row[*column]))
            .collect::<Vec<_>>()
            .join(",")
    ));
}
#[test]
fn process_loss_actual_snapshot_matches_original_fixture_and_includes_every_eligible_thread() {
    let fixture = Fixture::new(true);
    let data = plan_fixture();
    insert(&fixture, &data["rows"][1]);
    let before = fixture
        .writer()
        .scalar("SELECT group_concat(status || ':' || payload_json) FROM orchestration_v2_effect_outbox");
    let observed = process_loss(&fixture.main, &fixture.owner).unwrap();
    assert_eq!(observed.plan_digest, data["planDigest"].as_str().unwrap());
    assert_eq!((observed.row_count, observed.cancelled, observed.requeued), (2, 1, 1));
    assert_eq!(
        fixture
            .writer()
            .scalar("SELECT group_concat(status || ':' || payload_json) FROM orchestration_v2_effect_outbox"),
        before
    );
    let mut unrelated = data["rows"][1].clone();
    unrelated["effect_id"] = json!("unaffected");
    unrelated["status"] = json!("pending");
    insert(&fixture, &unrelated);
    assert_eq!(
        process_loss(&fixture.main, &fixture.owner).unwrap().plan_digest,
        observed.plan_digest
    );
    unrelated["effect_id"] = json!("another-thread");
    unrelated["thread_id"] = json!("foreign-thread");
    unrelated["status"] = json!("running");
    insert(&fixture, &unrelated);
    let changed = process_loss(&fixture.main, &fixture.owner).unwrap();
    assert_eq!((changed.row_count, changed.cancelled, changed.requeued), (3, 1, 2));
    assert_ne!(changed.plan_digest, observed.plan_digest);
}
#[test]
fn process_loss_actual_schema_and_size_changes_never_return_a_partial_observation() {
    for mode in ["schema", "trigger", "foreign-key", "rows", "bytes"] {
        let fixture = Fixture::new(true);
        match mode {
            "schema" => fixture
                .writer()
                .exec("ALTER TABLE orchestration_v2_effect_outbox ADD COLUMN extra TEXT"),
            "trigger" => fixture
                .writer()
                .exec("CREATE TRIGGER unrecognized_trigger AFTER UPDATE ON orchestration_v2_effect_outbox BEGIN SELECT 1; END"),
            "foreign-key" => fixture.writer().exec(
                "CREATE UNIQUE INDEX status_reference ON orchestration_v2_effect_outbox(status);
                CREATE TABLE outside_recovery (status TEXT REFERENCES ORCHESTRATION_V2_EFFECT_OUTBOX(status) ON UPDATE CASCADE);
                INSERT INTO outside_recovery VALUES ('pending')",
            ),
            "rows" => {
                for i in 0..256 {
                    let mut row = fixture.data["row"].clone();
                    row["effect_id"] = json!(format!("new-{i:04}"));
                    insert(&fixture, &row);
                }
            }
            _ => fixture
                .writer()
                .exec("UPDATE orchestration_v2_effect_outbox SET payload_json = replace(hex(zeroblob(524288)), '0', 'x')"),
        }
        assert!(process_loss(&fixture.main, &fixture.owner).is_err());
    }
}

#[test]
fn process_loss_actual_sql_selects_the_complete_original_type_and_status_matrix() {
    use nessie_windows_common::execution_process_loss as loss;
    let fixture = Fixture::new(true);
    let mut selected = vec![fixture.data["row"].clone()];
    for effect_type in loss::PROCESS_BOUND.iter().chain(loss::REPLAY_SAFE.iter()).chain(["unknown"].iter()) {
        for status in ["pending", "running", "cancelled", "failed", "succeeded"] {
            let mut row = fixture.data["row"].clone();
            row["effect_id"] = json!(format!("matrix-{effect_type}-{status}"));
            row["effect_type"] = json!(effect_type);
            row["status"] = json!(status);
            insert(&fixture, &row);
            if (loss::PROCESS_BOUND.contains(effect_type) && ["pending", "running"].contains(&status))
                || (loss::REPLAY_SAFE.contains(effect_type) && status == "running")
            {
                selected.push(row);
            }
        }
    }
    selected.sort_by(|a, b| a["effect_id"].as_str().unwrap().cmp(b["effect_id"].as_str().unwrap()));
    let expected = loss::observe(selected, 1).unwrap();
    let actual = process_loss(&fixture.main, &fixture.owner).unwrap();
    assert_eq!((actual.row_count, actual.cancelled, actual.requeued), (21, 11, 10));
    assert_eq!(actual.plan_digest, expected.plan_digest);
}
