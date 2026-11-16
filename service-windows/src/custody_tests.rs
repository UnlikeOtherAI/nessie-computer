use super::reconcile;
use crate::custody_store::{Fence, Host, State, Store};
use nessie_windows_common::{custody::{Record, RuntimeKind, VERSION}, process::{Owned, Process}};
use std::{os::windows::{ffi::OsStrExt, io::AsRawHandle, process::CommandExt},
    process::{Child, Command, Stdio}};
use windows_sys::Win32::{Foundation::HANDLE, System::{
    JobObjects::{AssignProcessToJobObject, CreateJobObjectW},
    Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED}}};

struct TestChild(Child);

impl Drop for TestChild {
    fn drop(&mut self) {
        // Only the exact process handle created by this fixture is eligible for cleanup.
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn suspended() -> TestChild {
    let program =
        std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/cmd.exe");
    TestChild(
        Command::new(program)
            .args(["/D", "/C", "exit /B 0"])
            .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}


fn named_job() -> (String, Owned) {
    let name = format!(
        "Global\\NessieCustody-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let wide: Vec<u16> = std::ffi::OsStr::new(&name)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let job = Owned(unsafe { CreateJobObjectW(std::ptr::null(), wide.as_ptr()) });
    assert!(!job.0.is_null());
    (name, job)
}


#[test]
fn ended_legacy_controllers_retire_without_stopping_a_daemon_or_its_other_work() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::new(directory.path());
    let (name, job) = named_job();
    let root = suspended();
    let unknown = suspended();
    let mut controller = suspended();
    for child in [&root, &unknown] {
        assert_eq!(unsafe { AssignProcessToJobObject(job.0, child.0.as_raw_handle() as HANDLE) }, 1);
    }
    let node = Process::open(root.0.id()).unwrap();
    let actor = Process::open(std::process::id()).unwrap();
    let ended = Process::open(controller.0.id()).unwrap().generation;
    controller.0.kill().unwrap();
    controller.0.wait().unwrap();
    let host = Host { owner_sid: actor.sid.clone(), controller: ended,
        runtime_child: node.generation.clone(), job_name: name.clone() };
    let mut state = State { version: VERSION, ..State::default() };
    // The observed Maxis backlog, beside a live controller that must stay active.
    for index in 0..1316 { state.hosts.insert(format!("{index:064x}"), host.clone()); }
    state.hosts.insert("live".into(), Host { controller: actor.generation.clone(), ..host });
    state.runtimes.insert("daemon".into(), Record { protocol_version: 1, guard_version: VERSION,
        supervisor: actor.generation.clone(), child: node.generation.clone(), owner_sid: actor.sid.clone(),
        session_id: actor.session, release_digest: "b".repeat(64), job_name: name, kind: RuntimeKind::UserDaemon });
    state.fences.insert("revoked".into(), Fence { owner_sid: actor.sid.clone(),
        controller: actor.generation.clone(), revoked: true, clear_requested: false });
    store.write(&state).unwrap();
    reconcile(&store, &mut state).unwrap();
    assert_eq!(state.hosts.len(), 1);
    assert!(state.hosts.contains_key("live"));
    assert_eq!(state.runtimes.len(), 1);
    assert!(state.fences["revoked"].revoked);
    assert!(node.alive());
    assert!(Process::open(unknown.0.id()).unwrap().alive());
    store.write(&state).unwrap();
    reconcile(&store, &mut state).unwrap();
    assert_eq!(state.hosts.len(), 1, "reconciliation is repeatable without deleting live controllers");
    let archives = std::fs::read_dir(directory.path().join("custody/retired-host-admissions"))
        .unwrap().collect::<Result<Vec<_>, _>>().unwrap();
    assert_eq!(archives.len(), 1);
    let evidence: serde_json::Value = serde_json::from_slice(&std::fs::read(archives[0].path()).unwrap()).unwrap();
    assert_eq!(evidence["hosts"].as_object().unwrap().len(), 1316);
}
