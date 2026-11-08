use super::{pipe, resource::Resource, test_fixture::{directory, Fixture}};
use serde_json::json;
use std::{fs, time::{Duration, Instant}};

#[test]
fn actual_readonly_sqlite_retains_wal_rows_original_ids_and_order() {
    let fixture = Fixture::new(false);
    fixture.writer.exec("INSERT INTO projection_thread_messages (message_id,thread_id,text,created_at)
        VALUES ('b','雪','later','2001-01-02'),('a','雪','earlier','2001-01-01')");
    let mut source = Resource::open(&fixture.request).unwrap();
    source.database.transaction("BEGIN").unwrap();
    let query = source.database.query("rows", Some("projection_thread_messages")).unwrap();
    let id = query["statement"].as_u64().unwrap();
    assert_eq!(source.database.next(id).unwrap()["row"]["message_id"], "a");
    fixture.writer.exec("INSERT INTO projection_thread_messages (message_id,thread_id,text,created_at)
        VALUES ('c','雪','appended','2001-01-03')");
    assert_eq!(source.database.next(id).unwrap()["row"]["message_id"], "b");
    assert_eq!(source.database.next(id).unwrap()["done"], true);
    source.database.finish(id).unwrap();
    source.database.transaction("COMMIT").unwrap();
    source.recheck().unwrap();
    assert!(source.database.query("rows", Some("auth_sessions")).is_err());
    assert!(source.database.query("rows", Some("../auth_sessions")).is_err());
    assert!(source.database.transaction("DELETE FROM projection_threads").is_err());
}

#[test]
fn v2_is_authoritative_and_a_bad_v2_never_falls_back_to_legacy() {
    let fixture = Fixture::new(true);
    fs::write(fixture.root.join("state.sqlite"), "not selected").unwrap();
    let source = Resource::open(&fixture.request).unwrap();
    assert_eq!(source.description["source"]["databaseRole"], "authoritative-v2");
    drop(source);
    let legacy = Fixture::new(false);
    fs::write(legacy.root.join("statev2.sqlite"), "corrupt").unwrap();
    assert!(Resource::open(&legacy.request).is_err());
}

#[test]
fn aliases_have_equal_kernel_identity_and_separate_roots_do_not_merge() {
    let mut fixture = Fixture::new(false);
    fixture.reconfigure(json!([
        {"admittedRootKey":"one","kind":"configured-home","stateDirectory":fixture.root},
        {"admittedRootKey":"two","kind":"configured-home","stateDirectory":fixture.root.to_str().unwrap().to_uppercase().replace("USERDATA","userdata")}
    ]));
    fixture.request["manifest"]["homes"] = json!([
        {"admittedRootKey":"one","kind":"configured-home"},{"admittedRootKey":"two","kind":"configured-home"}]);
    let first = Resource::open(&fixture.request).unwrap();
    fixture.request["admittedRootKey"] = json!("two");
    let alias = Resource::open(&fixture.request).unwrap();
    assert_eq!(first.description["source"]["physicalRootKey"], alias.description["source"]["physicalRootKey"]);
    let other = Fixture::new(false);
    let other = Resource::open(&other.request).unwrap();
    assert_eq!(first.description["source"]["environmentId"], other.description["source"]["environmentId"]);
    assert_ne!(first.description["source"]["physicalRootKey"], other.description["source"]["physicalRootKey"]);
}

#[test]
fn replacements_are_denied_at_each_protocol_wait_boundary() {
    for operation in ["describe", "recheck", "transaction", "query", "next", "finalize", "close"] {
        let fixture = Fixture::new(false);
        let mut source = Resource::open(&fixture.request).unwrap();
        let statement = source.database.query("rows", Some("projection_threads")).unwrap()["statement"].as_u64().unwrap();
        for path in [fixture.root.clone(), fixture.database.clone(), fixture.root.join("environment-id"),
            std::path::PathBuf::from(format!("{}-wal",fixture.database.display())),
            std::path::PathBuf::from(format!("{}-shm",fixture.database.display()))] {
            assert!(fs::rename(&path, path.with_extension("replaced")).is_err(), "{operation}: {}",path.display());
        }
        pipe::dispatch(&json!({"op":operation,"action":"BEGIN","query":"migrations","statement":statement}), &mut source).unwrap();
        source.recheck().unwrap();
    }
}

#[test]
fn revocation_role_creation_and_expiry_are_sticky() {
    let mut fixture = Fixture::new(false);
    let source = Resource::open(&fixture.request).unwrap();
    fixture.reconfigure(json!([]));
    assert!(source.recheck().is_err());
    fixture.reconfigure(json!([{"admittedRootKey":"one","kind":"configured-home","stateDirectory":fixture.root}]));
    assert!(source.recheck().is_err());
    drop(source);
    let mut source = Resource::open(&fixture.request).unwrap();
    fs::write(fixture.root.join("statev2.sqlite"), "appeared").unwrap();
    fs::remove_file(fixture.root.join("statev2.sqlite")).unwrap();
    assert!(source.recheck().is_err());
    source.expire_for_test(Instant::now() - Duration::from_secs(61));
    assert!(source.recheck().is_err());
}

#[test]
fn missing_traversal_reparse_and_nonprivate_roots_refuse() {
    let mut fixture = Fixture::new(false);
    let env = fixture.root.join("environment-id"); fs::remove_file(&env).unwrap();
    assert!(Resource::open(&fixture.request).is_err());
    fs::write(&env, "env:雪").unwrap();
    for path in [fixture.root.join("..\\userdata"), fixture.root.join("missing"),
        std::path::PathBuf::from(r"\\localhost\C$\userdata")] {
        fixture.reconfigure(json!([{"admittedRootKey":"one","kind":"configured-home","stateDirectory":path}]));
        assert!(Resource::open(&fixture.request).is_err());
    }
    let linked = fixture.temporary.path().join("alias");
    std::os::windows::fs::symlink_dir(&fixture.root, &linked).expect("qualification requires symlink privilege");
    fixture.reconfigure(json!([{"admittedRootKey":"one","kind":"configured-home","stateDirectory":linked.join("userdata")} ]));
    assert!(Resource::open(&fixture.request).is_err());
    let foreign = fixture.temporary.path().join("foreign"); directory(&foreign);
    fixture.reconfigure(json!([{"admittedRootKey":"one","kind":"configured-home","stateDirectory":fixture.root}]));
    let status = std::process::Command::new("icacls").arg(&fixture.root).args(["/grant","*S-1-1-0:R"]).status().unwrap();
    assert!(status.success()); assert!(Resource::open(&fixture.request).is_err());
}

#[test]
fn request_macs_bind_direction_sequence_and_bytes() {
    let key = [7_u8;32]; let body = r#"{"op":"describe"}"#;
    assert_ne!(pipe::mac(&key,"request",1,body), pipe::mac(&key,"response",1,body));
    assert_ne!(pipe::mac(&key,"request",1,body), pipe::mac(&key,"request",2,body));
    assert_ne!(pipe::mac(&key,"request",1,body), pipe::mac(&[8;32],"request",1,body));
}
