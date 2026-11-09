//! Real pinned original schema/rows and held readonly Windows snapshots. These
//! component tests do not establish an enrolled mutation or lifecycle grant.
use super::*;
use crate::execution_resource::destination::recovery_inputs::read;
use serde_json::Value;

fn data() -> Value {
    serde_json::from_str(include_str!(
        "../../test/t3-session-runtime/fixtures/recovery-projection-inputs.json"
    ))
    .unwrap()
}
fn fixture() -> Fixture {
    let fixture = Fixture::new(true);
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
#[test]
fn recovery_inputs_actual_held_queries_match_original_and_preserve_source_rows() {
    let fixture = fixture();
    let value = data();
    let thread = value["threadId"].as_str().unwrap();
    let before = fixture
        .writer()
        .scalar("SELECT group_concat(payload_json) FROM orchestration_v2_projection_runs");
    let actual = read(&fixture.main, &fixture.owner, thread).unwrap();
    assert_eq!(actual.input_digest, value["inputDigest"].as_str().unwrap());
    assert_eq!(
        before,
        fixture
            .writer()
            .scalar("SELECT group_concat(payload_json) FROM orchestration_v2_projection_runs")
    );
    fixture.writer().exec("UPDATE orchestration_v2_projection_runs SET payload_json = ' ' || payload_json WHERE thread_id = 'unselected'");
    assert_eq!(
        read(&fixture.main, &fixture.owner, thread)
            .unwrap()
            .input_digest,
        actual.input_digest
    );
    fixture.writer().exec("UPDATE orchestration_v2_projection_runs SET payload_json = ' ' || payload_json WHERE thread_id <> 'unselected'");
    assert_ne!(
        read(&fixture.main, &fixture.owner, thread)
            .unwrap()
            .input_digest,
        actual.input_digest
    );
    assert!(read(&fixture.main, &fixture.owner, "missing").is_err());
}
#[test]
fn recovery_inputs_refuse_nonordinary_projection_tables_and_actual_vm_expiry() {
    let fixture = fixture();
    fixture.writer().exec(
        "ALTER TABLE orchestration_v2_projection_threads RENAME TO replaced_threads;
        CREATE VIEW orchestration_v2_projection_threads AS SELECT * FROM replaced_threads",
    );
    assert!(read(
        &fixture.main,
        &fixture.owner,
        data()["threadId"].as_str().unwrap()
    )
    .is_err());
    unsafe extern "C" fn allow(
        _: *mut c_void,
        _: c_int,
        _: *const c_char,
        _: *const c_char,
        _: *const c_char,
        _: *const c_char,
    ) -> c_int {
        0
    }
    let result = snapshot_with_authorizer(&fixture.main, &fixture.owner, allow, |connection| {
        connection.set_deadline(std::time::Instant::now());
        connection.read_one(
            "WITH RECURSIVE work(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM work WHERE n < 10000000)
            SELECT sum(n) FROM work",
            &[],
        )
    });
    assert!(
        result.is_err(),
        "the actual SQLite VM must stop, not merely a check after it returns"
    );
}
