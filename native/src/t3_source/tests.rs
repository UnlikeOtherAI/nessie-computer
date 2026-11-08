use super::{pipe, resource::Resource, test_fixture::{directory, Fixture, Writer}};
use serde_json::json;
use std::fs;

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
    let main = source.description["databaseIdentity"].as_str().unwrap();
    let wal = source.description["sidecarIdentities"][0].as_str().unwrap();
    source.database.verify_files(main, Some(wal)).unwrap();
    assert!(source.database.verify_files(wal, Some(wal)).is_err(), "actual main handle must match");
    assert!(source.database.verify_files(main, Some(main)).is_err(), "actual WAL handle must match");
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
fn directory_write_handles_cannot_cross_admission_or_its_wait_boundaries() {
    use windows_sys::Win32::{Foundation::{CloseHandle, INVALID_HANDLE_VALUE}, Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_SHARE_DELETE, OPEN_EXISTING,
    }};
    let fixture = Fixture::new(false);
    let open_writer = || unsafe { CreateFileW(super::handles::wide(&fixture.root).as_ptr(), 0x4000_0000,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, std::ptr::null(), OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, std::ptr::null_mut()) };
    // This is the write access needed to turn an existing directory into a
    // reparse point. A handle acquired before admission must also be excluded.
    let writer = open_writer();
    assert_ne!(writer, INVALID_HANDLE_VALUE);
    assert!(Resource::open(&fixture.request).is_err());
    unsafe { CloseHandle(writer); }
    let mut source = Resource::open(&fixture.request).unwrap();
    for operation in ["describe", "recheck", "query", "close"] {
        let handle = open_writer();
        if handle != INVALID_HANDLE_VALUE { unsafe { CloseHandle(handle); } }
        assert_eq!(handle, INVALID_HANDLE_VALUE, "{operation}");
        pipe::dispatch(&json!({"op":operation,"query":"migrations"}), &mut source).unwrap();
    }
}

#[test]
fn rollback_mode_opens_readonly_and_missing_wal_sidecars_refuse() {
    let fixture = Fixture::new(false);
    drop(fixture.writer);
    assert!(Resource::open(&fixture.request).is_err(), "WAL mode without its sidecars");
    let writer = Writer::open(&fixture.database);
    writer.exec("PRAGMA journal_mode=DELETE");
    drop(writer);
    let names = || {
        let mut entries = fs::read_dir(&fixture.root).unwrap().map(|entry| entry.unwrap().file_name()).collect::<Vec<_>>();
        entries.sort(); entries
    };
    let before = names();
    let mut source = Resource::open(&fixture.request).unwrap();
    source.database.transaction("BEGIN").unwrap();
    let id = source.database.query("migrations", None).unwrap()["statement"].as_u64().unwrap();
    assert_eq!(source.database.next(id).unwrap()["row"]["migration_id"], 1);
    source.database.finish(id).unwrap();
    source.database.transaction("COMMIT").unwrap();
    source.recheck().unwrap();
    drop(source);
    assert_eq!(before, names(), "reader must not create sidecars");
}

#[test]
fn acl_revocation_refuses_every_receiver_operation() {
    for operation in ["describe", "recheck", "transaction", "query", "next", "finalize", "close"] {
        let fixture = Fixture::new(false);
        let mut source = Resource::open(&fixture.request).unwrap();
        let statement = source.database.query("migrations", None).unwrap()["statement"].as_u64().unwrap();
        let status = std::process::Command::new("icacls").arg(&fixture.root)
            .args(["/grant", "*S-1-1-0:R"]).status().unwrap();
        assert!(status.success());
        assert!(pipe::dispatch(&json!({"op":operation,"action":"BEGIN","query":"migrations",
            "statement":statement}), &mut source).is_err(), "{operation}");
    }
}

#[test]
fn writable_sidecar_attribute_change_and_restore_is_sticky_at_every_wait() {
    for operation in ["describe", "recheck", "transaction", "query", "next", "finalize", "close"] {
        for suffix in ["", "-wal", "-shm"] {
            let fixture = Fixture::new(false);
            let mut source = Resource::open(&fixture.request).unwrap();
            let statement = source.database.query("migrations", None).unwrap()["statement"].as_u64().unwrap();
            let path = std::path::PathBuf::from(format!("{}{suffix}", fixture.database.display()));
            let previous = fs::metadata(&path).unwrap().permissions();
            let mut changed = previous.clone(); changed.set_readonly(!previous.readonly());
            fs::set_permissions(&path, changed).unwrap();
            fs::set_permissions(&path, previous).unwrap();
            assert!(pipe::dispatch(&json!({"op":operation,"action":"BEGIN","query":"migrations",
                "statement":statement}), &mut source).is_err(), "{operation}: {suffix}");
        }
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
    let source = Resource::open(&fixture.request).unwrap();
    source.renew().unwrap();
    fs::write(fixture.root.join("statev2.sqlite"), "appeared").unwrap();
    fs::remove_file(fixture.root.join("statev2.sqlite")).unwrap();
    assert!(source.recheck().is_err());
    let fresh = Fixture::new(false);
    let expired = Resource::open(&fresh.request).unwrap();
    expired.recheck().unwrap();
    expired.expire_for_test();
    assert!(expired.recheck().is_err());
    assert!(expired.renew().is_err());
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
    std::os::windows::fs::symlink_dir(fixture.temporary.path(), &linked).expect("qualification requires symlink privilege");
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
