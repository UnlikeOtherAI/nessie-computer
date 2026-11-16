use super::*;
use std::io::Write;

fn fixture(value: &str) -> (tempfile::TempDir, std::path::PathBuf, String) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("daemon.pid");
    fs::write(&path, value).unwrap();
    let owner = crate::lease_windows::file_owner_sid(&File::open(&path).unwrap()).unwrap();
    (directory, path, owner)
}

#[test]
fn only_positive_absence_or_a_different_principal_retires_legacy_bytes() {
    for fact in [
        ProcessFact::Absent,
        ProcessFact::Present {
            started_at: "999".into(),
            sid: Some("S-1-5-18".into()),
        },
    ] {
        let (_directory, path, owner) = fixture("42\n");
        assert_ne!(owner, "S-1-5-18", "run this fixture as a user, not SYSTEM");
        assert!(retire_file(&path, &owner, |pid| {
            assert_eq!(pid, 42);
            fact
        }));
        assert!(!path.exists());
    }
}

#[test]
fn unknown_same_owner_and_unowned_files_are_preserved() {
    let (_directory, path, owner) = fixture("42\n");
    for fact in [
        ProcessFact::Unknown,
        ProcessFact::Present {
            started_at: "999".into(),
            sid: None,
        },
        ProcessFact::Present {
            started_at: "999".into(),
            sid: Some(owner.clone()),
        },
    ] {
        assert!(!retire_file(&path, &owner, |_| fact));
        assert_eq!(fs::read(&path).unwrap(), b"42\n");
    }
    assert!(!retire_file(&path, "S-1-5-21-1-2-3-1001", |_| panic!(
        "foreign owner"
    )));
    assert_eq!(fs::read(&path).unwrap(), b"42\n");
}

#[test]
fn modern_and_malformed_leases_never_enter_upgrade_retirement() {
    for value in [
        "",
        "42 garbage",
        "0",
        "{\"version\":1,\"pid\":42,\"startedAt\":\"123\",\"token\":\"db895064-b147-43d9-98b4-27c9ba31eefb\"}",
        "{\"version\":2,\"pid\":42,\"startedAt\":\"123\",\"token\":\"db895064-b147-43d9-98b4-27c9ba31eefb\",\"bootId\":\"01234567-89ab-cdef-0123-456789abcdef\"}",
    ] {
        let (_directory, path, owner) = fixture(value);
        assert!(!retire_file(&path, &owner, |_| panic!("not a legacy owner")));
        assert_eq!(fs::read_to_string(&path).unwrap(), value);
    }
    let (_directory, path, owner) = fixture(&"1".repeat(4097));
    assert!(!retire_file(&path, &owner, |_| panic!("oversized")));
    assert_eq!(fs::metadata(path).unwrap().len(), 4097);
}

#[test]
fn held_file_cannot_be_replaced_by_a_competing_reclaimer() {
    let (_directory, path, owner) = fixture("42");
    let contender = path.clone();
    assert!(retire_file(&path, &owner, |_| {
        std::thread::spawn(move || {
            assert!(fs::remove_file(&contender).is_err());
            assert!(fs::write(&contender, "other owner's claim").is_err());
            let replacement = contender.with_extension("draft");
            fs::write(&replacement, "other owner's claim").unwrap();
            assert!(fs::rename(&replacement, &contender).is_err());
        })
        .join()
        .unwrap();
        ProcessFact::Absent
    }));
    assert!(!path.exists());
    // After close, the next owner publishes normally and remains untouched.
    let mut next = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    next.write_all(b"{\"version\":2}").unwrap();
    drop(next);
    assert!(!retire_file(&path, &owner, |_| panic!(
        "replacement is not legacy"
    )));
    assert_eq!(fs::read(&path).unwrap(), b"{\"version\":2}");
}

#[test]
fn writer_in_progress_and_reparse_points_are_never_retired() {
    let (_directory, path, owner) = fixture("42");
    let writer = OpenOptions::new().write(true).open(&path).unwrap();
    assert!(!retire_file(&path, &owner, |_| panic!(
        "writer holds publication"
    )));
    drop(writer);
    let link = path.with_extension("link");
    std::os::windows::fs::symlink_file(&path, &link).unwrap();
    assert!(!retire_file(&link, &owner, |_| panic!(
        "link is not a claim"
    )));
    assert_eq!(fs::read(&path).unwrap(), b"42");
    assert!(fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn real_windows_process_exit_recovers_without_signalling_any_process() {
    use std::os::windows::process::CommandExt;
    let mut child = std::process::Command::new("C:\\Windows\\System32\\cmd.exe")
        .args(["/d", "/c", "exit", "0"])
        .creation_flags(0x08000000)
        .spawn()
        .unwrap();
    let pid = child.id();
    child.wait().unwrap();
    let (_directory, path, owner) = fixture(&pid.to_string());
    assert!(matches!(
        crate::lease_windows::observe(pid),
        ProcessFact::Absent
    ));
    assert!(retire_file(&path, &owner, crate::lease_windows::observe));
    assert!(!path.exists());
}
