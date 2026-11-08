//! Receiver component tests use actual Windows file/ACL/process objects. They
//! do not exercise or substitute for authenticate_graph / SYSTEM creation.
use super::*;
use nessie_windows_common::{execution::{Binding, Target}, execution_resource::{Object, Source}};
use std::{fs::{self, File}, os::windows::io::{AsRawHandle, FromRawHandle}};
use windows_sys::Win32::{Foundation::{LocalFree, INVALID_HANDLE_VALUE},
    Security::{Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SetFileSecurityW, OWNER_SECURITY_INFORMATION, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION},
    Storage::FileSystem::{CreateFileW, GetFileInformationByHandleEx, FileIdInfo, FILE_ID_INFO,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, OPEN_EXISTING}};

fn open(path: &Path, directory: bool, sid: &str, kind: &str) -> (File, Object) {
    let wide: Vec<u16> = path.to_str().unwrap().encode_utf16().chain(Some(0)).collect();
    let sddl: Vec<u16> = format!("O:{sid}D:P(A;;FA;;;{sid})(A;;FA;;;SY)").encode_utf16().chain(Some(0)).collect();
    let mut descriptor = std::ptr::null_mut();
    assert_ne!(unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor,
        std::ptr::null_mut()) }, 0);
    assert_ne!(unsafe { SetFileSecurityW(wide.as_ptr(), OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION
        | PROTECTED_DACL_SECURITY_INFORMATION, descriptor) }, 0);
    unsafe { LocalFree(descriptor); }
    let raw = unsafe { CreateFileW(wide.as_ptr(), 0x0002_0080 | if directory {0} else {0x8000_0000},
        FILE_SHARE_READ, std::ptr::null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        std::ptr::null_mut()) };
    assert_ne!(raw, INVALID_HANDLE_VALUE);
    let file = unsafe { File::from_raw_handle(raw) };
    let mut id: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    assert_ne!(unsafe { GetFileInformationByHandleEx(raw, FileIdInfo, (&mut id as *mut FILE_ID_INFO).cast(),
        std::mem::size_of::<FILE_ID_INFO>() as u32) }, 0);
    let identity = format!("{:016x}:{}", id.VolumeSerialNumber,
        id.FileId.Identifier.iter().map(|b| format!("{b:02x}")).collect::<String>());
    let object = Object { handle: file.as_raw_handle() as usize as u64, identity, kind: kind.into(), private: true };
    (file, object)
}
struct Fixture { native: Vec<File>, held: Held, root: tempfile::TempDir }
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("settings"), b"{}").unwrap();
    fs::write(root.path().join("environment"), b"original:env\n").unwrap();
    fs::write(root.path().join("database"), b"receiver component, not SQLite admission").unwrap();
    fs::write(root.path().join("configuration"), b"{}").unwrap();
    let caller = Process::open(std::process::id()).unwrap();
    let mut native = Vec::new(); let mut objects = Vec::new();
    let duplicator = Duplicator::new(&caller).unwrap();
    for kind in ["source-root", "settings", "environment", "database", "configuration"] {
        let path = if kind == "source-root" { root.path().to_owned() } else { root.path().join(kind) };
        let (file, object) = open(&path, kind == "source-root", &caller.sid, kind);
        objects.push(duplicator.file(&object, &caller.sid).unwrap()); native.push(file);
    }
    let identity = |kind: &str| objects.iter().find(|o| o.description.kind == kind).unwrap().description.identity.clone();
    let custody = Custody { service: caller.generation.clone(), controller: caller.generation.clone(),
        supervisor: caller.generation.clone(), runtime: caller.generation.clone(), job_name: "component-test".into(),
        release_digest: "a".repeat(64), service_image_digest: "b".repeat(64) };
    let source = Source { executor_id: "fixture".into(), admitted_root_key: "original".into(),
        physical_root_key: format!("windows-file-id:{:x}", Sha256::digest(identity("source-root").as_bytes())),
        environment_id: "original:env".into(), database_identity: identity("database"),
        environment_identity: identity("environment"), layout: "v2-80".into(), database_role: "authoritative-v2".into() };
    let evidence = Evidence { source, settings_identity: identity("settings"),
        settings_digest: format!("{:x}", Sha256::digest(b"{}")), settings_length: 2, provider_references: Vec::new() };
    let held = Held { receipt: Receipt { version: 1, resource_id: "a".repeat(64), resource_generation: "component-test".into(),
        evidence, custody }, caller, objects, watches: Vec::new(), deadline: Instant::now() + Duration::from_secs(10),
        config_digest: Sha256::digest(b"{}").to_vec(), graph_generation: None, inspections: HashMap::new(),
        paired_origin: "https://example.invalid".into(), service_root: root.path().into() };
    Fixture { root, native, held }
}
#[test]
fn execution_resource_receiver_retains_actual_files_and_rejects_substituted_source() {
    let mut fixture = fixture();
    fixture.held.validate_source().unwrap(); fixture.held.recheck_objects().unwrap();
    fixture.native.clear();
    assert!(fs::rename(fixture.root.path().join("settings"), fixture.root.path().join("replaced")).is_err());
    assert!(fs::write(fixture.root.path().join("settings"), "changed").is_err());
    fixture.held.receipt.evidence.source.environment_id = "different environment".into();
    assert!(fixture.held.validate_source().is_err());
    fixture.held.receipt.evidence.source.environment_id = "original:env".into();
    fixture.held.receipt.evidence.settings_digest = "f".repeat(64);
    assert!(fixture.held.recheck_objects().is_err());
}
#[test]
fn execution_resource_receiver_expiry_and_unlinked_registration_never_recover() {
    let fixture = fixture();
    let caller = Process::open(std::process::id()).unwrap();
    let context = DescriptorContext { paired_origin: fixture.held.paired_origin.clone(), custody: fixture.held.receipt.custody.clone() };
    let now = nessie_windows_common::execution::now_ms().unwrap();
    let graph = Graph { version: 1, nonce: "c".repeat(64), source_revision: "25bf84ab07f53f141c20239c63e383823a9d5ea0".into(),
        issued_at_ms: now, expires_at_ms: now + 5000, targets: vec![Target {kind:"thread".into(), id:"t".into(), scope:"existing".into(), environment_id:None}],
        binding: Binding { executor_id:"fixture".into(), environment_id:"original:env".into(), thread_id:"t".into(),
            provider_instance_id:"codex".into(), connection_epoch:"epoch".into(), runtime_generation:"writer".into(),
            correlation_id:"correlation".into(), command_id:"command".into(), request_sha256:format!("sha256:{}", "d".repeat(64)),
            relay_hmac:format!("hmac-sha256:{}", "e".repeat(64)), actor_reference:format!("sha256:{}", "a".repeat(64)),
            initiation_reference:format!("sha256:{}", "b".repeat(64)), source_evidence_digest:None,
            source_root_key:fixture.held.receipt.evidence.source.physical_root_key.clone(), source_generation:"capture".into(),
            driver:"codex".into(), continuation_home_key:"unissued".into(), history_home_key:"unissued".into(), credential_binding_id:"unissued".into() } };
    let id = fixture.held.receipt.resource_id.clone();
    resources().lock().unwrap().insert(id.clone(), fixture.held);
    assert!(bind_graph(&id, &caller, &context, &graph).is_err());
    assert!(!resources().lock().unwrap().contains_key(&id));
    let mut second = self::fixture();
    second.held.deadline = Instant::now();
    resources().lock().unwrap().insert(id.clone(), second.held);
    assert!(bind_graph(&id, &caller, &context, &graph).is_err());
    assert!(!resources().lock().unwrap().contains_key(&id));
}
