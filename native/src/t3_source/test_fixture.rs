//! Disposable Windows SQLite fixtures. These call real ACL and kernel APIs;
//! production has no injected admission boolean, clock or fake file inspector.
use serde_json::{json, Value};
use std::{ffi::{c_char, c_int, c_void, CString}, path::{Path, PathBuf}};

#[link(name = "winsqlite3")]
extern "C" {
    fn sqlite3_open_v2(path: *const c_char, db: *mut *mut c_void, flags: c_int, vfs: *const c_char) -> c_int;
    fn sqlite3_exec(db: *mut c_void, sql: *const c_char, callback: *const c_void,
        argument: *const c_void, error: *mut *mut c_char) -> c_int;
    fn sqlite3_close_v2(db: *mut c_void) -> c_int;
}
pub struct Writer(*mut c_void);
impl Writer {
    pub fn open(path: &Path) -> Self {
        let path = CString::new(path.to_str().unwrap()).unwrap();
        let mut raw = std::ptr::null_mut();
        assert_eq!(unsafe { sqlite3_open_v2(path.as_ptr(), &mut raw, 6, std::ptr::null()) }, 0);
        Self(raw)
    }
    pub fn exec(&self, sql: &str) {
        let sql = CString::new(sql).unwrap();
        assert_eq!(unsafe { sqlite3_exec(self.0, sql.as_ptr(), std::ptr::null(), std::ptr::null(), std::ptr::null_mut()) }, 0);
    }
}
impl Drop for Writer { fn drop(&mut self) { unsafe { sqlite3_close_v2(self.0); } } }

pub struct Fixture {
    pub writer: Writer,
    pub state: PathBuf,
    pub root: PathBuf,
    pub database: PathBuf,
    pub request: Value,
    pub temporary: tempfile::TempDir,
}
pub fn secure(path: &Path) {
    crate::state_security::secure_owner_only_file(path.to_str().unwrap()).unwrap();
}
pub fn directory(path: &Path) {
    crate::state_security::secure_directory(path.to_str().unwrap()).unwrap();
}
impl Fixture {
    pub fn new(v2: bool) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        directory(temporary.path());
        let state = temporary.path().join("executor"); directory(&state);
        let root = temporary.path().join("userdata"); directory(&root);
        let database = root.join(if v2 { "statev2.sqlite" } else { "state.sqlite" });
        let writer = Writer::open(&database);
        writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
            CREATE TABLE effect_sql_migrations (migration_id INTEGER, name TEXT);");
        let migrations: Vec<Value> = serde_json::from_str(include_str!("../../../src/t3-session/import/migration-manifest.json")).unwrap();
        for row in migrations.iter().take(if v2 { 80 } else { 54 }) {
            writer.exec(&format!("INSERT INTO effect_sql_migrations VALUES ({}, '{}')", row[0], row[1].as_str().unwrap()));
        }
        let definitions: Vec<Value> = serde_json::from_str(include_str!("../../../src/t3-session/source/tables.json")).unwrap();
        for row in definitions.iter().take(if v2 { definitions.len() } else { 4 }) {
            let name = row["name"].as_str().unwrap();
            let mut columns = row["columns"].as_array().unwrap().iter().map(|value| {
                let column = value.as_str().unwrap();
                format!("{column} {}", if ["sequence", "ordinal", "application_event_version"].contains(&column) { "INTEGER" } else { "TEXT" })
            }).collect::<Vec<_>>();
            if v2 && name == "projection_projects" { columns.extend(["pinned_at TEXT".into(), "archived_at TEXT".into()]); }
            writer.exec(&format!("CREATE TABLE {name} ({})", columns.join(", ")));
        }
        writer.exec("CREATE TABLE auth_sessions (credential TEXT); INSERT INTO auth_sessions VALUES ('FORBIDDEN_NATIVE_CANARY')");
        std::fs::write(root.join("environment-id"), "env:雪\n").unwrap();
        let homes = json!([{"admittedRootKey":"one","kind":"configured-home","stateDirectory":root}]);
        std::fs::write(state.join("executor-state.json"), serde_json::to_vec(&json!({"executorId":"fixture",
            "descriptor":{"revision":1},"t3SourceHomes":homes})).unwrap()).unwrap();
        for path in [database.clone(), root.join("environment-id"), state.join("executor-state.json"),
            PathBuf::from(format!("{}-wal",database.display())), PathBuf::from(format!("{}-shm",database.display()))] { secure(&path); }
        let request = json!({"stateDirectory":state,"executorId":"fixture","admittedRootKey":"one",
            "manifest":{"revision":"1","homes":[{"admittedRootKey":"one","kind":"configured-home"}]}});
        Self { writer, state, root, database, request, temporary }
    }
    pub fn reconfigure(&mut self, homes: Value) {
        std::fs::write(self.state.join("executor-state.json"), serde_json::to_vec(&json!({"executorId":"fixture",
            "descriptor":{"revision":1},"t3SourceHomes":homes})).unwrap()).unwrap();
    }
}
