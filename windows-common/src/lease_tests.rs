use super::*;
use std::fs;
const TOKEN: &str = "db895064-b147-43d9-98b4-27c9ba31eefb";
const BOOT: &str = "01234567-89ab-cdef-0123-456789abcdef";

fn claim(version: u8, pid: u32, birth: &str) -> String {
    let boot = if version == 2 {
        format!(",\"bootId\":\"{BOOT}\"")
    } else {
        String::new()
    };
    format!("{{\"version\":{version},\"pid\":{pid},\"startedAt\":\"{birth}\",\"token\":\"{TOKEN}\"{boot}}}")
}
fn live(birth: &str, sid: Option<&str>) -> ProcessFact {
    ProcessFact::Present {
        started_at: birth.into(),
        sid: sid.map(str::to_owned),
    }
}
#[test]
fn only_missing_files_are_absent_and_malformed_records_stay_busy() {
    let directory = tempfile::tempdir().unwrap();
    assert_eq!(read_daemon_lease(directory.path()), DaemonLease::Absent);
    assert!(!blocks(&DaemonLease::Absent, None, None, |_| panic!(
        "no process lookup"
    )));
    for bytes in [
        "",
        " ",
        "0",
        "-1",
        "not-a-pid",
        "12 34",
        "2147483648",
        "{\"version\":3}",
    ] {
        fs::write(directory.path().join(DAEMON_LEASE_FILE), bytes).unwrap();
        assert_eq!(read_daemon_lease(directory.path()), DaemonLease::Suspect);
        assert!(unowned_daemon_is_stopping(directory.path()));
    }
    fs::write(directory.path().join(DAEMON_LEASE_FILE), "x".repeat(4097)).unwrap();
    assert_eq!(read_daemon_lease(directory.path()), DaemonLease::Suspect);
    fs::remove_file(directory.path().join(DAEMON_LEASE_FILE)).unwrap();
    fs::create_dir(directory.path().join(DAEMON_LEASE_FILE)).unwrap();
    assert_eq!(read_daemon_lease(directory.path()), DaemonLease::Suspect);
}
#[test]
fn both_published_generation_formats_recover_only_positive_absence() {
    for version in [1, 2] {
        let lease = parse(&claim(version, 42, "1234"));
        assert!(matches!(lease, DaemonLease::Generation { .. }));
        assert!(blocks(&lease, Some(BOOT), None, |_| live("1234", None)));
        assert!(!blocks(&lease, Some(BOOT), None, |_| live("5678", None)));
        assert!(!blocks(&lease, Some(BOOT), None, |_| ProcessFact::Absent));
        assert!(blocks(&lease, Some(BOOT), None, |_| ProcessFact::Unknown));
    }
    let lease = parse(&claim(2, 42, "1234"));
    assert!(blocks(&lease, None, None, |_| panic!(
        "unknown boot remains unknown"
    )));
    assert!(!blocks(&lease, Some("different-boot"), None, |_| panic!(
        "old boot cannot own PID"
    )));
}
#[test]
fn legacy_same_owner_and_unreadable_identity_remain_busy() {
    let lease = parse("42\n");
    assert_eq!(lease, DaemonLease::Legacy(42));
    assert!(blocks(&lease, None, Some("owner"), |_| live(
        "123",
        Some("owner")
    )));
    assert!(blocks(&lease, None, Some("owner"), |_| live("123", None)));
    assert!(blocks(&lease, None, None, |_| live("123", Some("other"))));
    assert!(blocks(&lease, None, Some("owner"), |_| {
        ProcessFact::Unknown
    }));
    assert!(!blocks(&lease, None, Some("owner"), |_| live(
        "123",
        Some("other")
    )));
    assert!(!blocks(&lease, None, Some("owner"), |_| {
        ProcessFact::Absent
    }));
}
#[test]
fn substitutions_and_partial_claims_are_not_process_absence() {
    let valid = claim(2, 42, "1234");
    for invalid in [
        valid.replace("\"version\":2", "\"version\":3"),
        valid.replace("\"pid\":42", "\"pid\":0"),
        valid.replace("\"pid\":42", "\"pid\":2147483648"),
        valid.replace("\"1234\"", "\"1.5\""),
        valid.replace("\"1234\"", "\"\""),
        valid.replace(TOKEN, "not-a-token"),
        valid.replace(TOKEN, "db895064-b147-13d9-98b4-27c9ba31eefb"),
        valid.replace(BOOT, "not-a-boot"),
        valid.replace('}', ",\"extra\":true}"),
        valid.replace("\"version\":2", "\"version\":1"),
        claim(1, 42, "1234").replace('}', ",\"bootId\":null}"),
    ] {
        assert_eq!(parse(&invalid), DaemonLease::Suspect, "{invalid}");
    }
}
#[cfg(windows)]
#[test]
fn real_windows_generation_checks_never_signal_the_replacement() {
    use std::os::windows::process::CommandExt;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(DAEMON_LEASE_FILE);
    let mut child = std::process::Command::new("C:\\Windows\\System32\\cmd.exe")
        .args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"])
        .creation_flags(0x08000000)
        .spawn()
        .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let ProcessFact::Present { started_at, sid } = crate::lease_windows::observe(child.id())
        else {
            panic!("fixture process must be readable")
        };
        assert!(sid.is_some());
        let boot = crate::process::boot_id().unwrap();
        let value = claim(2, child.id(), &started_at).replace(BOOT, &boot);
        fs::write(&path, &value).unwrap();
        assert!(unowned_daemon_is_stopping(directory.path()));
        fs::write(
            &path,
            value.replace(
                &format!("\"startedAt\":\"{started_at}\""),
                "\"startedAt\":\"0\"",
            ),
        )
        .unwrap();
        assert!(!unowned_daemon_is_stopping(directory.path()));
        assert!(
            child.try_wait().unwrap().is_none(),
            "observing PID reuse must not signal the current process"
        );
        fs::write(&path, format!("{}\n", child.id())).unwrap();
        assert!(
            unowned_daemon_is_stopping(directory.path()),
            "legacy same account is unknown"
        );
        // A group-owned fixture file stays unknown; no group is treated as an individual.
        fs::write(&path, value).unwrap();
    }));
    child.kill().unwrap();
    child.wait().unwrap();
    if let Err(error) = result {
        std::panic::resume_unwind(error)
    }
    assert!(!unowned_daemon_is_stopping(directory.path()));
}
