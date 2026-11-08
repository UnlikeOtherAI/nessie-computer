//! Actual Windows handles and disposable source data. No admission success flag.
use super::{execution_settings::Settings, resource::Resource, test_fixture::{Fixture, directory, secure}};
use nessie_windows_common::{execution_resource_handles::Duplicator, process::Process};
use serde_json::json;
use std::fs;

fn settings(f: &Fixture, value: serde_json::Value) {
    fs::write(f.root.join("settings.json"), serde_json::to_vec(&value).unwrap()).unwrap();
    secure(&f.root.join("settings.json"));
}
#[test]
fn execution_settings_are_read_from_the_same_held_source_and_retain_exact_bytes() {
    let f = Fixture::new(true);
    settings(&f, json!({"providerInstances":{},"threadTitleInstructions":"雪"}));
    let expected = fs::read(f.root.join("settings.json")).unwrap();
    let source = Resource::open(&f.request).unwrap();
    let mut held = Settings::open(source.execution_root().unwrap()).unwrap();
    assert_eq!(held.bytes().unwrap(), expected);
    assert_eq!(held.length(), expected.len());
    assert!(held.references().is_empty());
    // The retained protocol cannot acquire settings, even for the same root.
    let mut other = Resource::open(&f.request).unwrap();
    assert!(super::pipe::dispatch(&json!({"op":"executionDescribe"}), &mut other).is_err());
    // WAL activity is permitted; it is not a settings-generation change.
    f.writer.exec("INSERT INTO projection_threads (thread_id) VALUES ('settings-held')");
    source.recheck().unwrap();
    assert_eq!(held.bytes().unwrap(), expected);
}
#[test]
fn every_settings_boundary_excludes_replacement_and_existing_writers() {
    let f = Fixture::new(false);
    settings(&f, json!({}));
    let path = f.root.join("settings.json");
    let writer = fs::OpenOptions::new().write(true).open(&path).unwrap();
    let source = Resource::open(&f.request).unwrap();
    assert!(Settings::open(source.execution_root().unwrap()).is_err());
    drop(writer);
    let mut first = Settings::open(source.execution_root().unwrap()).unwrap();
    let mut second = Settings::open(source.execution_root().unwrap()).unwrap();
    for _ in ["decode", "select", "inspect", "reserve", "prepare", "launch", "associate", "return"] {
        assert!(fs::write(&path, b"changed").is_err());
        assert!(fs::rename(&path, path.with_extension("replacement")).is_err());
        assert_eq!(first.bytes().unwrap(), second.bytes().unwrap());
    }
}
#[test]
fn only_explicit_original_homes_issue_opaque_refs_and_shadow_does_not_change_history() {
    let f = Fixture::new(true);
    let shared = f.temporary.path().join("codex-explicit"); directory(&shared);
    let shadow = f.temporary.path().join("codex-account"); directory(&shadow);
    // Sentinel credential child is not read or added to any receipt.
    fs::write(shadow.join("auth.json"), "SECRET_SENTINEL_NOT_A_SETTINGS_DTO").unwrap();
    settings(&f, json!({"providerInstances":{
        "original-alias": {"driver":"codex","config":{"homePath":shared,"shadowHomePath":shadow}},
        "default": {"driver":"claudeAgent","config":{}},
        "managed": {"driver":"codex","config":{"setupMode":"managed","homePath":shared}},
        "disabled": {"driver":"claudeAgent","enabled":false,"config":{"homePath":shared}}
    }}));
    let source = Resource::open(&f.request).unwrap();
    let held = Settings::open(source.execution_root().unwrap()).unwrap();
    let refs = held.references();
    assert_eq!(refs.len(), 3);
    assert!(refs.iter().all(|r| r.instance_id == "original-alias"));
    let identity = |role: &str| &refs.iter().find(|r| r.role == role).unwrap().identity;
    assert_eq!(identity("history"), identity("continuation"));
    assert_ne!(identity("history"), identity("credential"));
    assert!(refs.iter().all(|r| r.reference_id.len() == 64 && r.reference_id != r.identity));
    let serialized = serde_json::to_string(refs).unwrap();
    assert!(!serialized.contains("SECRET_SENTINEL"));
    assert!(!serialized.contains("codex-explicit"));
    assert!(!serialized.contains("codex-account"));
}
#[test]
fn original_driver_codec_fixture_binds_claude_agent_home_and_normalizes_only_receipt() {
    let f = Fixture::new(true);
    // The same fixture is decoded with the actual pinned ServerSettings,
    // ProviderInstanceConfigMap, CodexSettings and ClaudeSettings in the JS lane.
    let mut original: serde_json::Value = serde_json::from_str(include_str!(
        "../../../test/t3-session-source/fixtures/execution-settings.json")).unwrap();
    let shared = f.temporary.path().join("codex-shared"); directory(&shared);
    let shadow = f.temporary.path().join("codex-shadow"); directory(&shadow);
    let claude = f.temporary.path().join("claude-explicit"); directory(&claude);
    let entries = &mut original["providerInstances"];
    entries["codex-original"]["config"]["homePath"] = json!(shared);
    entries["codex-original"]["config"]["shadowHomePath"] = json!(shadow);
    entries["claude-original"]["config"]["homePath"] = json!(claude);
    // These fields belong to Codex, not ClaudeSettings. Claude must ignore them.
    entries["claude-original"]["config"]["shadowHomePath"] = json!(shadow);
    entries["claude-original"]["config"]["setupMode"] = json!("managed");
    entries["wire-name-is-not-original"] = json!({"driver":"claude","config":{"homePath":claude}});
    settings(&f, original);
    let source = Resource::open(&f.request).unwrap();
    let mut held = Settings::open(source.execution_root().unwrap()).unwrap();
    assert_eq!(held.references().len(), 6);
    let claude_refs = held.references().iter().filter(|r| r.instance_id == "claude-original").collect::<Vec<_>>();
    assert_eq!(claude_refs.len(), 3);
    let identity = super::handles::chain(&claude).unwrap().last().unwrap().identity.clone();
    assert!(claude_refs.iter().all(|r| r.driver == "claude" && r.identity == identity));
    for role in ["history", "continuation", "credential"] { assert!(claude_refs.iter().any(|r| r.role == role)); }
    assert!(held.references().iter().all(|r| r.instance_id != "wire-name-is-not-original"));
    let bytes: serde_json::Value = serde_json::from_slice(&held.bytes().unwrap()).unwrap();
    assert_eq!(bytes["providerInstances"]["claude-original"]["driver"], "claudeAgent");
}
#[test]
fn unavailable_traversal_reparse_and_oversized_settings_refuse() {
    let f = Fixture::new(false);
    let source = Resource::open(&f.request).unwrap();
    assert!(Settings::open(source.execution_root().unwrap()).is_err());
    drop(source);
    for bytes in [b"bad json".to_vec(), b"[]".to_vec(), vec![b' '; 1024 * 1024 + 1]] {
        fs::write(f.root.join("settings.json"), bytes).unwrap(); secure(&f.root.join("settings.json"));
        let source = Resource::open(&f.request).unwrap();
        assert!(Settings::open(source.execution_root().unwrap()).is_err());
    }
    for home in ["C:\\absent-provider-root-for-fixture", "C:\\fixture\\..\\provider", "~/.codex", "relative"] {
        settings(&f, json!({"providerInstances":{"codex":{"driver":"codex","config":{"homePath":home}}}}));
        let source = Resource::open(&f.request).unwrap();
        assert!(Settings::open(source.execution_root().unwrap()).is_err());
    }
    fs::remove_file(f.root.join("settings.json")).unwrap();
    let target = f.temporary.path().join("other-settings.json"); fs::write(&target, "{}").unwrap(); secure(&target);
    std::os::windows::fs::symlink_file(&target, f.root.join("settings.json")).unwrap();
    let source = Resource::open(&f.request).unwrap();
    assert!(Settings::open(source.execution_root().unwrap()).is_err());
}
#[test]
fn service_duplicates_real_handles_and_keeps_settings_pinned_after_native_drop() {
    let f = Fixture::new(true);
    settings(&f, json!({"providerInstances":{}}));
    let source = Resource::open(&f.request).unwrap();
    let held = Settings::open(source.execution_root().unwrap()).unwrap();
    let caller = Process::open(std::process::id()).unwrap();
    let duplicate = Duplicator::new(&caller).unwrap();
    let objects = held.objects();
    let receipt = duplicate.file(&objects[0], &caller.sid).unwrap();
    assert_eq!(receipt.bytes(1024 * 1024).unwrap(), fs::read(f.root.join("settings.json")).unwrap());
    let mut forged = objects[0].clone(); forged.identity = "not-the-held-object".into();
    assert!(duplicate.file(&forged, &caller.sid).is_err());
    assert!(duplicate.file(&objects[0], "S-1-5-18").is_err());
    drop(held);
    assert!(fs::write(f.root.join("settings.json"), "{}").is_err());
    receipt.recheck(&caller.sid).unwrap();
    drop(receipt);
    fs::write(f.root.join("settings.json"), "{}").unwrap();
}
#[test]
fn settings_security_change_is_sticky_even_after_acl_restore() {
    use windows_sys::Win32::Security::Authorization::{SetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
    let f = Fixture::new(false); settings(&f, json!({}));
    let source = Resource::open(&f.request).unwrap();
    let held = Settings::open(source.execution_root().unwrap()).unwrap();
    let path = super::handles::wide(&f.root.join("settings.json"));
    assert_eq!(unsafe { SetNamedSecurityInfoW(path.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
        std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) }, 0);
    assert!(held.recheck().is_err());
    secure(&f.root.join("settings.json"));
    assert!(held.recheck().is_err());
}
