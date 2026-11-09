//! Real Windows SQLite/handle components. These do not substitute for protected
//! graph authentication, a native signature or current operation admission.
#[path = "execution_destination_lineage_tests.rs"]
mod lineage_tests;
#[path = "execution_destination_process_loss_tests.rs"]
mod process_loss_tests;
#[path = "execution_destination_legacy_shell_tests.rs"]
mod legacy_shell_tests;
#[path = "execution_destination_recovery_inputs_tests.rs"]
mod recovery_inputs_tests;
use super::*;
use nessie_windows_common::{
    execution_resource::Object,
    execution_resource_handles::{file_identity, HeldCandidateDirectory},
    process::Process,
};
use std::{
    ffi::CString,
    fs::{self, File},
    os::windows::{ffi::OsStrExt, io::FromRawHandle},
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::{LocalFree, INVALID_HANDLE_VALUE},
    Security::{
        Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SetFileSecurityW,
        DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    },
    Storage::FileSystem::{
        CreateFileW, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    },
};

#[link(name = "winsqlite3")]
extern "C" {
    fn sqlite3_open_v2(path: *const c_char, db: *mut *mut c_void, flags: c_int, vfs: *const c_char) -> c_int;
    fn sqlite3_exec(
        db: *mut c_void,
        sql: *const c_char,
        callback: *const c_void,
        arg: *const c_void,
        error: *mut *mut c_char,
    ) -> c_int;
    fn sqlite3_close_v2(db: *mut c_void) -> c_int;
    fn sqlite3_prepare_v2(
        db: *mut c_void,
        sql: *const c_char,
        bytes: c_int,
        stmt: *mut *mut c_void,
        tail: *const c_void,
    ) -> c_int;
    fn sqlite3_step(stmt: *mut c_void) -> c_int;
    fn sqlite3_column_text(stmt: *mut c_void, index: c_int) -> *const c_char;
    fn sqlite3_finalize(stmt: *mut c_void) -> c_int;
}
struct Writer(*mut c_void);
impl Writer {
    fn open(path: &Path) -> Self {
        let path = CString::new(path.to_str().unwrap()).unwrap();
        let mut raw = std::ptr::null_mut();
        assert_eq!(
            unsafe { sqlite3_open_v2(path.as_ptr(), &mut raw, 6, std::ptr::null()) },
            0
        );
        Self(raw)
    }
    fn exec(&self, sql: &str) {
        let sql = CString::new(sql).unwrap();
        assert_eq!(
            unsafe {
                sqlite3_exec(
                    self.0,
                    sql.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null_mut(),
                )
            },
            0
        );
    }
    fn scalar(&self, sql: &str) -> String {
        let sql = CString::new(sql).unwrap();
        let mut statement = std::ptr::null_mut();
        assert_eq!(
            unsafe { sqlite3_prepare_v2(self.0, sql.as_ptr(), -1, &mut statement, std::ptr::null()) },
            0
        );
        assert_eq!(unsafe { sqlite3_step(statement) }, 100);
        let result = unsafe { CStr::from_ptr(sqlite3_column_text(statement, 0)) }
            .to_str()
            .unwrap()
            .into();
        assert_eq!(unsafe { sqlite3_finalize(statement) }, 0);
        result
    }
}
impl Drop for Writer {
    fn drop(&mut self) {
        assert_eq!(unsafe { sqlite3_close_v2(self.0) }, 0);
    }
}
fn secure(path: &Path, owner: &str, directory: bool) {
    let inheritance = if directory { "OICI" } else { "" };
    let text: Vec<u16> = format!("O:{owner}D:P(A;{inheritance};FA;;;{owner})(A;{inheritance};FA;;;SY)")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = std::ptr::null_mut();
    assert_ne!(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        },
        0
    );
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    assert_ne!(
        unsafe {
            SetFileSecurityW(
                path.as_ptr(),
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                descriptor,
            )
        },
        0
    );
    unsafe {
        LocalFree(descriptor);
    }
}
fn held(path: &Path, owner: &str) -> HeldObject {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            0x8002_0080,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    assert_ne!(raw, INVALID_HANDLE_VALUE);
    let object = HeldObject {
        file: unsafe { File::from_raw_handle(raw) },
        description: Object {
            handle: 0,
            identity: file_identity(raw).unwrap(),
            kind: "database".into(),
            private: true,
        },
    };
    object.single_file_path(owner).unwrap();
    object
}
fn literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".into(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        _ => panic!("fixture scalar"),
    }
}
struct Fixture {
    writer: Option<Writer>,
    main: HeldObject,
    _directory: HeldCandidateDirectory,
    owner: String,
    path: PathBuf,
    data: Value,
    _root: tempfile::TempDir,
}
impl Fixture {
    fn new(wal: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let owner = Process::open(std::process::id()).unwrap().sid;
        secure(root.path(), &owner, true);
        let path = root.path().join("capture.sqlite");
        let writer = Writer::open(&path);
        writer.exec(if wal {
            "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0"
        } else {
            "PRAGMA journal_mode=DELETE"
        });
        writer.exec("CREATE TABLE orchestration_v2_effect_outbox (effect_id TEXT PRIMARY KEY, command_id TEXT,
            thread_id TEXT, effect_type TEXT, payload_json TEXT, status TEXT, attempt_count INTEGER, available_at TEXT,
            lease_owner TEXT, lease_expires_at TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT, last_error TEXT);
            CREATE TABLE orchestration_command_receipts (command_id TEXT PRIMARY KEY, aggregate_kind TEXT, aggregate_id TEXT,
            accepted_at TEXT, result_sequence INTEGER, status TEXT, error TEXT, command_type TEXT);
            CREATE TABLE auth_sessions (credential TEXT); INSERT INTO auth_sessions VALUES ('FORBIDDEN_OBSERVER_CANARY')");
        let data: Value = serde_json::from_str(include_str!(
            "../../test/t3-session-runtime/fixtures/pending-effect-row.json"
        ))
        .unwrap();
        for (table, key, columns) in [
            ("orchestration_v2_effect_outbox", "row", ROW_COLUMNS),
            ("orchestration_command_receipts", "receipt", RECEIPT_COLUMNS),
        ] {
            writer.exec(&format!(
                "INSERT INTO {table} ({}) VALUES ({})",
                columns.join(","),
                columns
                    .iter()
                    .map(|column| literal(&data[key][*column]))
                    .collect::<Vec<_>>()
                    .join(",")
            ));
        }
        for suffix in ["", "-wal", "-shm"] {
            let file = PathBuf::from(format!("{}{suffix}", path.display()));
            if file.exists() {
                secure(&file, &owner, false);
            }
        }
        let main = held(&path, &owner);
        let directory = HeldCandidateDirectory::open(root.path(), &owner).unwrap();
        Self {
            writer: Some(writer),
            main,
            _directory: directory,
            owner,
            path,
            data,
            _root: root,
        }
    }
    fn writer(&self) -> &Writer {
        self.writer.as_ref().unwrap()
    }
    fn observe(&self) -> Result<Option<Observation>, String> {
        observe(&self.main, &self.owner, "thread:雪:one", "effect:雪:one")
    }
}

#[test]
fn pending_row_actual_wal_snapshot_matches_all_fields_without_claiming_or_disclosing_values() {
    let fixture = Fixture::new(true);
    let before = fixture
        .writer()
        .scalar("SELECT status || ':' || attempt_count || ':' || payload_json FROM orchestration_v2_effect_outbox");
    let observed = fixture.observe().unwrap().unwrap();
    assert_eq!(observed.row_digest, fixture.data["rowDigest"].as_str().unwrap());
    assert_eq!(observed.command_type, "prepared-run.release");
    assert!(!serde_json::to_string(&observed).unwrap().contains("PRIVATE_ROW_CANARY"));
    assert_eq!(
        fixture
            .writer()
            .scalar("SELECT status || ':' || attempt_count || ':' || payload_json FROM orchestration_v2_effect_outbox"),
        before
    );
    fixture
        .writer()
        .exec("UPDATE orchestration_v2_effect_outbox SET lease_expires_at = NULL");
    assert_ne!(fixture.observe().unwrap().unwrap().row_digest, observed.row_digest);
}
#[test]
fn pending_row_uses_bound_selectors_and_returns_no_facts_for_foreign_missing_or_settled_work() {
    let fixture = Fixture::new(true);
    for (thread, effect) in [("foreign-thread", "effect:雪:one"), ("thread:雪:one", "' OR 1=1 --")] {
        assert!(observe(&fixture.main, &fixture.owner, thread, effect)
            .unwrap()
            .is_none());
    }
    fixture
        .writer()
        .exec("UPDATE orchestration_command_receipts SET status = 'rejected'");
    assert!(fixture.observe().unwrap().is_none());
    fixture.writer().exec(
        "UPDATE orchestration_command_receipts SET status = 'accepted';
        UPDATE orchestration_v2_effect_outbox SET status = 'running'",
    );
    assert!(fixture.observe().unwrap().is_none());
}
#[test]
fn pending_row_reader_denies_writes_private_tables_extensions_and_mode_changes() {
    let fixture = Fixture::new(true);
    let files = FileSnapshot::open(&fixture.main, &fixture.owner).unwrap();
    let mut reader = Connection::open(files.path(), authorize).unwrap();
    for (sql, params) in [
        ("DELETE FROM orchestration_v2_effect_outbox", vec![]),
        ("SELECT credential FROM auth_sessions", vec![]),
        ("SELECT load_extension(?)", vec!["caller-library"]),
        ("PRAGMA journal_mode=DELETE", vec![]),
        ("ATTACH DATABASE ? AS caller", vec!["caller.sqlite"]),
    ] {
        assert!(reader.read_one(sql, &params).is_err());
    }
    assert_eq!(
        fixture
            .writer()
            .scalar("SELECT count(*) FROM orchestration_v2_effect_outbox"),
        "1"
    );
}
#[test]
fn pending_row_refuses_views_extra_columns_and_ambiguous_payloads() {
    let fixture = Fixture::new(true);
    fixture.writer().exec(
        "UPDATE orchestration_v2_effect_outbox SET payload_json =
        '{\"type\":\"wrong\",\"type\":\"provider-turn.start\"}'",
    );
    assert!(fixture.observe().is_err());
    fixture
        .writer()
        .exec("ALTER TABLE orchestration_v2_effect_outbox ADD COLUMN caller_authority TEXT");
    assert!(fixture.observe().is_err());
    fixture.writer().exec(
        "DROP TABLE orchestration_v2_effect_outbox;
        CREATE VIEW orchestration_v2_effect_outbox AS SELECT credential FROM auth_sessions",
    );
    assert!(fixture.observe().is_err());
}
#[test]
fn pending_row_actual_main_wal_identity_and_sticky_namespace_witness_cannot_be_replaced() {
    let fixture = Fixture::new(true);
    let files = FileSnapshot::open(&fixture.main, &fixture.owner).unwrap();
    let other = Fixture::new(true);
    let mut reader = Connection::open(&other.path, authorize).unwrap();
    reader
        .read_one("SELECT effect_id FROM orchestration_v2_effect_outbox", &[])
        .unwrap();
    assert!(files.verify(&reader).is_err());
    assert!(fs::rename(
        PathBuf::from(format!("{}-wal", fixture.path.display())),
        fixture.path.with_extension("replacement")
    )
    .is_err());
    let marker = fixture.path.parent().unwrap().join("new-name");
    fs::write(&marker, []).unwrap();
    fs::remove_file(&marker).unwrap();
    assert!(files.recheck().is_err());
}
#[test]
fn pending_row_rollback_is_readonly_and_missing_wal_sidecars_never_create_a_fallback() {
    let fixture = Fixture::new(false);
    assert!(fixture.observe().unwrap().is_some());
    let mut fixture = Fixture::new(true);
    drop(fixture.writer.take());
    let before = fs::read(&fixture.path).unwrap();
    assert!(fixture.observe().is_err());
    assert_eq!(fs::read(&fixture.path).unwrap(), before);
    for suffix in ["-wal", "-shm"] {
        assert!(!PathBuf::from(format!("{}{suffix}", fixture.path.display())).exists());
    }
}
