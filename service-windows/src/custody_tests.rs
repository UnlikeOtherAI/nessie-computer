use super::{host_members_cleared, job_members};
use crate::custody_store::{Host, State};
use nessie_windows_common::{
    custody::VERSION,
    process::{Owned, Process},
};
use std::{
    os::windows::{ffi::OsStrExt, io::AsRawHandle, process::CommandExt},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::HANDLE,
    System::{
        JobObjects::{AssignProcessToJobObject, CreateJobObjectW},
        Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED},
    },
};

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

fn wait_for_root_only(host: &Host, root: &Process, unknown_pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let members =
            job_members(&host.job_name).expect("query the fixture's kernel job membership");
        assert!(
            root.alive(),
            "root exited during membership observation: job={} root={} unknown={} members={members:?}",
            host.job_name, host.runtime_child.pid, unknown_pid
        );
        if members == vec![host.runtime_child.pid] {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "kernel job did not become root-only: job={} root={} unknown={} final_members={members:?}",
            host.job_name, host.runtime_child.pid, unknown_pid
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn independent_job_membership_refuses_live_unknown_children_and_recovers_without_stopping_root() {
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
    let mut root = suspended();
    let mut unknown = suspended();
    assert_eq!(
        unsafe { AssignProcessToJobObject(job.0, root.0.as_raw_handle() as HANDLE) },
        1
    );
    let actor = Process::open(std::process::id()).unwrap();
    let node = Process::open(root.0.id()).unwrap();
    let host = Host {
        owner_sid: actor.sid.clone(),
        controller: actor.generation.clone(),
        runtime_child: node.generation.clone(),
        job_name: name.clone(),
    };
    let mut state = State {
        version: VERSION,
        ..State::default()
    };
    state.hosts.insert("a".repeat(64), host.clone());
    assert_eq!(job_members(&name).unwrap(), vec![root.0.id()]);
    assert!(host_members_cleared(&state, &host, None).unwrap());
    assert_eq!(
        unsafe { AssignProcessToJobObject(job.0, unknown.0.as_raw_handle() as HANDLE) },
        1
    );
    assert!(unknown.0.try_wait().unwrap().is_none());
    assert!(!host_members_cleared(&state, &host, None).unwrap());
    let unknown_pid = unknown.0.id();
    unknown.0.kill().unwrap();
    unknown.0.wait().unwrap();
    // Exit signalling does not prove job detachment; release this fixture's process handle too.
    drop(unknown);
    wait_for_root_only(&host, &node, unknown_pid);
    assert!(
        host_members_cleared(&state, &host, None).unwrap(),
        "root-only membership must admit release: final_members={:?}",
        job_members(&name)
    );
    assert!(node.alive());
    root.0.kill().unwrap();
    root.0.wait().unwrap();
}
