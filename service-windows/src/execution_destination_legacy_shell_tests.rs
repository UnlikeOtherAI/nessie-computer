//! Real held Windows SQLite against the original package's complete fixture.
//! No enrolled signer, admission, SQL mutation or provider success is implied.
use super::super::super::legacy_shell;
use super::*;

fn shell_fixture() -> Fixture {
    let fixture = Fixture::new(true);
    fixture.writer().exec(
        "DROP TABLE orchestration_v2_effect_outbox;
        DROP TABLE orchestration_command_receipts; DROP TABLE auth_sessions",
    );
    let data: Value = serde_json::from_str(include_str!(
        "../../test/t3-session-runtime/fixtures/legacy-shell-plan.json"
    ))
    .unwrap();
    for statement in data["schemaStatements"].as_array().unwrap() {
        fixture.writer().exec(statement.as_str().unwrap());
    }
    for statement in data["dataStatements"].as_array().unwrap() {
        fixture.writer().exec(statement.as_str().unwrap());
    }
    fixture
}
#[test]
fn legacy_shell_actual_snapshot_matches_complete_original_plan_and_all_targets_without_writes() {
    let fixture = shell_fixture();
    let expected: Value = serde_json::from_str(include_str!(
        "../../test/t3-session-runtime/fixtures/legacy-shell-plan.json"
    ))
    .unwrap();
    let before = fixture
        .writer()
        .scalar("SELECT count(*) FROM orchestration_events");
    let observed = legacy_shell::observe(&fixture.main, &fixture.owner).unwrap();
    assert_eq!(
        observed.plan_digest,
        expected["planDigest"].as_str().unwrap()
    );
    assert_eq!(
        serde_json::to_value(&observed.targets).unwrap(),
        expected["targets"]
    );
    assert!(!serde_json::to_string(&observed)
        .unwrap()
        .contains("PRIVATE_"));
    assert_eq!(
        fixture
            .writer()
            .scalar("SELECT count(*) FROM orchestration_events"),
        before
    );
    fixture
        .writer()
        .exec("UPDATE projection_thread_messages SET text = 'changed complete preview'");
    assert_ne!(
        legacy_shell::observe(&fixture.main, &fixture.owner)
            .unwrap()
            .plan_digest,
        observed.plan_digest
    );
    fixture.writer().exec("INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
        SELECT 'native:additional', project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at FROM projection_threads LIMIT 1");
    assert_eq!(
        legacy_shell::observe(&fixture.main, &fixture.owner)
            .unwrap()
            .targets
            .len(),
        3
    );
}
#[test]
fn legacy_shell_actual_snapshot_refuses_foreign_event_ownership_schema_and_whole_plan_overflow() {
    for mode in ["trigger", "foreign-key", "view", "event-target", "bytes"] {
        let fixture = shell_fixture();
        match mode {
            "trigger" => fixture.writer().exec("CREATE TRIGGER caller_trigger AFTER INSERT ON
                orchestration_v2_projection_threads BEGIN SELECT 1; END"),
            "foreign-key" => fixture.writer().exec("CREATE TABLE foreign_shell_reference
                (target TEXT REFERENCES orchestration_v2_projection_threads(thread_id) ON DELETE CASCADE)"),
            "view" => fixture.writer().exec("DROP TABLE projection_thread_messages;
                CREATE VIEW projection_thread_messages AS SELECT * FROM projection_threads"),
            "event-target" => fixture.writer().exec("INSERT INTO orchestration_events
                (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind,
                payload_json, metadata_json, application_event_version) VALUES
                ('migration:v1:message:native:import:雪:'':message:0', 'thread', 'native:repair', 99,
                'message.updated', '2026-01-01T00:00:00.000Z', 'system', '{}', '{}', 2)"),
            _ => fixture.writer().exec("UPDATE projection_thread_messages
                SET text = replace(hex(zeroblob(2097153)), '0', 'x')"),
        }
        assert!(
            legacy_shell::observe(&fixture.main, &fixture.owner).is_err(),
            "accepted {mode}"
        );
    }
}

#[test]
fn legacy_shell_actual_reader_denies_private_tables_writes_extensions_and_mode_changes() {
    let fixture = shell_fixture();
    fixture.writer().exec(
        "CREATE TABLE private_observer_canary (credential TEXT);
        INSERT INTO private_observer_canary VALUES ('FORBIDDEN_NATIVE_SHELL_CANARY')",
    );
    let files = FileSnapshot::open(&fixture.main, &fixture.owner).unwrap();
    let mut reader = Connection::open(files.path(), legacy_shell::authorize).unwrap();
    for query in [
        "SELECT credential FROM private_observer_canary",
        "DELETE FROM projection_threads",
        "SELECT load_extension('caller-library')",
        "PRAGMA journal_mode=DELETE",
        "ATTACH DATABASE 'caller.sqlite' AS caller",
    ] {
        assert!(reader.read_one(query, &[]).is_err(), "accepted {query}");
    }
    assert_eq!(
        fixture
            .writer()
            .scalar("SELECT count(*) FROM projection_threads"),
        "2"
    );
}
