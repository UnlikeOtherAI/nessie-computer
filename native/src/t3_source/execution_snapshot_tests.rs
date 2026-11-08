//! Actual held Windows SQLite snapshots; no service/custody success is simulated.
use super::{execution_snapshot::Snapshot, resource::Resource, test_fixture::Fixture};
use serde_json::{json, Value};

fn open(snapshot: &mut Snapshot, source: &mut Resource) -> String {
    snapshot.dispatch(&json!({"op":"executionSnapshotOpen"}), source).unwrap()["snapshotId"]
        .as_str().unwrap().to_owned()
}
fn read(snapshot: &mut Snapshot, source: &mut Resource, id: &str, request: Value) -> Value {
    snapshot.dispatch(&json!({"op":"executionSnapshotRead","snapshotId":id,"request":request}), source).unwrap()
}
fn rows(snapshot: &mut Snapshot, source: &mut Resource, id: &str, table: &str) -> Vec<Value> {
    let statement = read(snapshot, source, id, json!({"op":"query","query":"rows","table":table}))["statement"].clone();
    let mut rows = Vec::new();
    loop {
        let next = read(snapshot, source, id, json!({"op":"next","statement":statement}));
        if next["done"] == true { break; }
        rows.push(next["row"].clone());
    }
    read(snapshot, source, id, json!({"op":"finalize","statement":statement}));
    rows
}
fn close(snapshot: &mut Snapshot, source: &mut Resource, id: &str, action: &str) {
    snapshot.dispatch(&json!({"op":"executionSnapshotClose","snapshotId":id,"action":action}), source).unwrap();
}

#[test]
fn execution_snapshot_uses_same_connection_and_pins_wal_until_finite_return() {
    let fixture = Fixture::new(false);
    fixture.writer.exec("INSERT INTO projection_threads (thread_id,created_at) VALUES ('original-first','2001-01-01')");
    let mut source = Resource::open(&fixture.request).unwrap();
    let identity = source.description.clone();
    let mut snapshot = Snapshot::default();
    let first = open(&mut snapshot, &mut source);
    fixture.writer.exec("INSERT INTO projection_threads (thread_id,created_at) VALUES ('original-next','2001-01-02')");
    let old = rows(&mut snapshot, &mut source, &first, "projection_threads");
    assert_eq!(old.len(), 1);
    assert_eq!(old[0]["thread_id"], "original-first");
    // Inspect the very same database field: it sees that same pinned snapshot.
    let direct = source.database.query("rows", Some("projection_threads")).unwrap()["statement"].as_u64().unwrap();
    assert_eq!(source.database.next(direct).unwrap()["row"]["thread_id"], "original-first");
    assert_eq!(source.database.next(direct).unwrap()["done"], true);
    source.database.finish(direct).unwrap();
    close(&mut snapshot, &mut source, &first, "COMMIT");
    let next = open(&mut snapshot, &mut source);
    assert_ne!(first, next);
    let current = rows(&mut snapshot, &mut source, &next, "projection_threads");
    assert_eq!(current.iter().map(|r| r["thread_id"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["original-first", "original-next"]);
    assert_eq!(source.description, identity);
    close(&mut snapshot, &mut source, &next, "ROLLBACK");
}

#[test]
fn execution_snapshot_cleans_abandoned_cursors_and_refuses_previous_tokens() {
    let fixture = Fixture::new(true);
    let mut source = Resource::open(&fixture.request).unwrap();
    let mut snapshot = Snapshot::default();
    for _ in 0..12 {
        let id = open(&mut snapshot, &mut source);
        read(&mut snapshot, &mut source, &id, json!({"op":"query","query":"migrations"}));
        close(&mut snapshot, &mut source, &id, "COMMIT");
    }
    let old = open(&mut snapshot, &mut source);
    close(&mut snapshot, &mut source, &old, "ROLLBACK");
    let current = open(&mut snapshot, &mut source);
    assert!(snapshot.dispatch(&json!({"op":"executionSnapshotRead","snapshotId":old,
        "request":{"op":"query","query":"migrations"}}), &mut source).is_err());
    // Failure is sticky even if the caller restores the valid token.
    assert!(snapshot.dispatch(&json!({"op":"executionSnapshotRead","snapshotId":current,
        "request":{"op":"query","query":"migrations"}}), &mut source).is_err());
}

#[test]
fn execution_snapshot_refuses_arbitrary_sql_private_tables_writes_and_nested_transactions() {
    for request in [json!({"op":"query","query":"rows","table":"auth_sessions"}),
        json!({"op":"query","query":"migrations","sql":"SELECT * FROM auth_sessions"}),
        json!({"op":"transaction","action":"BEGIN"}), json!({"op":"transaction","action":"DROP TABLE projection_threads"})] {
        let fixture = Fixture::new(true);
        let mut source = Resource::open(&fixture.request).unwrap();
        let mut snapshot = Snapshot::default();
        let id = open(&mut snapshot, &mut source);
        assert!(snapshot.dispatch(&json!({"op":"executionSnapshotRead","snapshotId":id,"request":request}),
            &mut source).is_err());
    }
    let fixture = Fixture::new(false);
    let mut source = Resource::open(&fixture.request).unwrap();
    let mut snapshot = Snapshot::default();
    open(&mut snapshot, &mut source);
    assert!(snapshot.dispatch(&json!({"op":"executionSnapshotOpen"}), &mut source).is_err());
    assert!(super::pipe::dispatch(&json!({"op":"executionSnapshotOpen"}), &mut source).is_err());
}

#[test]
fn execution_snapshot_rechecks_physical_lease_at_each_read_boundary() {
    for boundary in ["query", "next", "finalize", "return"] {
        let fixture = Fixture::new(false);
        let mut source = Resource::open(&fixture.request).unwrap();
        let mut snapshot = Snapshot::default();
        let id = open(&mut snapshot, &mut source);
        let statement = read(&mut snapshot, &mut source, &id, json!({"op":"query","query":"migrations"}))["statement"].clone();
        assert!(std::fs::rename(&fixture.database, fixture.database.with_extension("replacement")).is_err());
        source.expire_for_test();
        let request = match boundary {
            "return" => json!({"op":"executionSnapshotClose","snapshotId":id,"action":"COMMIT"}),
            "query" => json!({"op":"executionSnapshotRead","snapshotId":id,"request":{"op":"query","query":"migrations"}}),
            op => json!({"op":"executionSnapshotRead","snapshotId":id,"request":{"op":op,"statement":statement}}),
        };
        assert!(snapshot.dispatch(&request, &mut source).is_err());
    }
}
