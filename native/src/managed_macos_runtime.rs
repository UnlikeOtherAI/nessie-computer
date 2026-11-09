//! Fixed signed release creation. Public journals outlive uncertain tree closure.
use crate::{managed_release, managed_runtime_context, macos_processes, protocol::NativeError};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, ffi::CString, fs::{self, File, OpenOptions}, io::{Read, Write},
    os::{fd::AsRawFd, unix::{ffi::OsStrExt, fs::{OpenOptionsExt, PermissionsExt}, net::UnixStream}},
    path::Path, sync::atomic::{AtomicI32, Ordering}, time::Duration};

fn refused() -> NativeError { NativeError::new("EXECUTOR_MANAGED_LAUNCH_REJECTED") }
static CHILD: AtomicI32 = AtomicI32::new(0);
extern "C" fn forward(signal: i32) {
    let pid = CHILD.load(Ordering::Relaxed);
    if pid > 0 { unsafe { libc::kill(-pid, signal); } }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub protocol_version: u32, pub boot_id: String, pub guard_version: u32,
    pub supervisor_pid: i32, pub supervisor_started_at: String,
    pub child_pid: i32, pub child_started_at: String, pub release_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
}

fn publish(path: &Path, record: &Record) -> Result<(), NativeError> {
    let draft = path.with_extension("draft");
    let mode = if unsafe { libc::getuid() } == 0 { 0o644 } else { 0o600 };
    let mut file = OpenOptions::new().write(true).create_new(true).mode(mode)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&draft).map_err(|_| refused())?;
    file.set_permissions(fs::Permissions::from_mode(mode)).map_err(|_| refused())?;
    file.write_all(&serde_json::to_vec(record).map_err(|_| refused())?).map_err(|_| refused())?;
    file.sync_all().map_err(|_| refused())?;
    fs::rename(&draft, path).map_err(|_| refused())?;
    File::open(path.parent().ok_or_else(refused)?).map_err(|_| refused())?.sync_all().map_err(|_| refused())
}

pub fn peer(stream: &UnixStream) -> Result<i32, NativeError> {
    let mut uid = 0; let mut gid = 0; let mut pid = 0_i32;
    let mut size = std::mem::size_of::<i32>() as libc::socklen_t;
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0
        || uid != unsafe { libc::getuid() }
        || unsafe { libc::getsockopt(stream.as_raw_fd(), 0, 2, (&mut pid as *mut i32).cast(), &mut size) } != 0
        || size as usize != std::mem::size_of::<i32>() || pid <= 0 { return Err(refused()); }
    Ok(pid)
}

fn probe(mut stream: UnixStream, record: &Record) -> Result<(), NativeError> {
    if !crate::updates::unix_health::authorize_probe(&stream) { return Err(refused()); }
    stream.set_read_timeout(Some(Duration::from_millis(250))).map_err(|_| refused())?;
    stream.set_write_timeout(Some(Duration::from_millis(250))).map_err(|_| refused())?;
    let mut nonce = [0_u8; 65];
    stream.read_exact(&mut nonce).map_err(|_| refused())?;
    if nonce[64] != b'\n' || !nonce[..64].iter().all(|byte| byte.is_ascii_hexdigit()) { return Err(refused()); }
    let nonce = std::str::from_utf8(&nonce[..64]).map_err(|_| refused())?;
    stream.write_all(&serde_json::to_vec(&serde_json::json!({"nonce":nonce,"record":record}))
        .map_err(|_| refused())?).map_err(|_| refused())
}

fn gated_child(release: &managed_release::Release, home: &Path, arguments: &[String]) -> Result<(i32, i32), NativeError> {
    // macOS has no fexecve. Resolve the pathname from the retained verified
    // kernel file description, rather than reopening an environment path.
    let mut path = [0_i8; 4096];
    if unsafe { libc::fcntl(release.node.as_raw_fd(), libc::F_GETPATH, path.as_mut_ptr()) } != 0 {
        return Err(refused());
    }
    let executable = unsafe { std::ffi::CStr::from_ptr(path.as_ptr()) }.to_owned();
    let arguments = std::iter::once(executable.clone())
        .chain(std::iter::once(CString::new(release.directory.join("nessie-executor.cjs").as_os_str().as_bytes())
            .map_err(|_| refused())?))
        .chain(arguments.iter().map(|value| CString::new(value.as_bytes())).collect::<Result<Vec<_>, _>>()
            .map_err(|_| refused())?).collect::<Vec<_>>();
    let mut argv = arguments.iter().map(|value| value.as_ptr()).collect::<Vec<_>>(); argv.push(std::ptr::null());
    let environment = managed_release::environment(home).into_iter().map(|(key, value)| {
        let mut bytes = key.as_bytes().to_vec(); bytes.push(b'='); bytes.extend_from_slice(value.as_bytes());
        CString::new(bytes).map_err(|_| refused())
    }).collect::<Result<Vec<_>, _>>()?;
    let mut envp = environment.iter().map(|value| value.as_ptr()).collect::<Vec<_>>(); envp.push(std::ptr::null());
    let gate = crate::unix_kernel::cloexec_pipe()?;
    let pid = unsafe { libc::fork() };
    if pid == 0 {
        unsafe {
            libc::close(gate[1]);
            if libc::setpgid(0, 0) != 0 { libc::_exit(125); }
            let mut byte = 0_u8;
            if libc::read(gate[0], (&mut byte as *mut u8).cast(), 1) != 1 || byte != 1 { libc::_exit(125); }
            libc::close(gate[0]);
            libc::execve(executable.as_ptr(), argv.as_ptr(), envp.as_ptr()); libc::_exit(125);
        }
    }
    unsafe { libc::close(gate[0]); }
    if pid < 0 { unsafe { libc::close(gate[1]); } return Err(refused()); }
    Ok((pid, gate[1]))
}

/// Whether this runtime admitted host execution that is still unresolved: a
/// `host_execution` registration its own child made in this boot. Another
/// runtime's registrations are not this journal's to keep, and a restart ended
/// any an earlier boot made. Counting every registration made each one-shot
/// command (`describe`, every five seconds) keep its journal and exit refused
/// once any team had run a local app: 371 journals in half an hour on
/// dictator, a team that never started and a runtime swap that never cleared.
fn unresolved_host(root: &Path, record: &Record) -> Result<bool, NativeError> {
    let file = match OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(root.join("guard.json")) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(refused()),
    };
    let state: serde_json::Value = serde_json::from_reader(file).map_err(|_| refused())?;
    Ok(state["registrations"].as_array().ok_or_else(refused)?.iter().any(|item| own_host(item, record)))
}

/// Drops this boot's journals that a one-shot command would have dropped
/// itself under `unresolved_host`: no long-lived activity, its supervisor and
/// child both ended, nothing left in the child's process group, and no host
/// registration of its own. Builds before this kept them whenever any team
/// held a host registration, and clearance waits for none to be left, so
/// without this a Mac recovered only by restarting. Daemons and anything still
/// running keep theirs.
fn reconcile(directory: &Path, boot: &str) -> Result<(), NativeError> {
    let root = directory.parent().ok_or_else(refused)?;
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(refused()),
    };
    let groups = macos_processes::live_groups()?;
    for entry in entries {
        let path = entry.map_err(|_| refused())?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") { continue; }
        let Ok(file) = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(&path) else { continue };
        let Ok(record) = serde_json::from_reader::<_, Record>(file) else { continue };
        if record.boot_id != boot || !ended_one_shot(&record, root, &groups)? { continue; }
        fs::remove_file(&path).map_err(|_| refused())?;
        let socket = path.with_extension("sock");
        if fs::symlink_metadata(&socket).is_ok() { fs::remove_file(&socket).map_err(|_| refused())?; }
    }
    File::open(directory).map_err(|_| refused())?.sync_all().map_err(|_| refused())
}

/// A one-shot command's journal its command would have dropped itself under
/// `unresolved_host`: no long-lived activity, supervisor and child ended,
/// nothing of any account left in the child's process group (`live_groups`,
/// taken once by the caller), and no host registration of its own under
/// `root`. A process this caller cannot read counts as still running. Update
/// clearance does not wait for these either.
pub(crate) fn ended_one_shot(
    record: &Record, root: &Path, live_groups: &std::collections::HashSet<i32>,
) -> Result<bool, NativeError> {
    let gone = |pid: i32, started: &str| match macos_processes::information(pid) {
        Ok(None) => true,
        Ok(Some(process)) => process.zombie || process.started_at != started,
        Err(_) => false,
    };
    // XNU, like every BSD, never hands out a pid that is still a process group
    // or session id. A child pid another process now holds therefore means the
    // child's group ended, and a live group with that id is the new process's.
    // On dictator three of 1888 journals met such a group and held the swap.
    let reused = matches!(macos_processes::information(record.child_pid),
        Ok(Some(process)) if process.started_at != record.child_started_at);
    Ok(record.activity.is_none()
        && gone(record.supervisor_pid, &record.supervisor_started_at)
        && gone(record.child_pid, &record.child_started_at)
        && (reused || !live_groups.contains(&record.child_pid))
        && !unresolved_host(root, record)?)
}

fn own_host(item: &serde_json::Value, record: &Record) -> bool {
    item["kind"] == "host_execution"
        && item["bootId"].as_str() == Some(record.boot_id.as_str())
        && item["pid"].as_i64() == Some(i64::from(record.child_pid))
        && item["startedAt"].as_str() == Some(record.child_started_at.as_str())
}

pub fn run(arguments: &[String]) -> Result<i32, NativeError> {
    let release = managed_release::load()?;
    let _retained_release = (&release.node, &release.node_digest, &release.handles);
    let barrier = managed_runtime_context::Barrier::acquire()?;
    managed_release::require_selected(&release)?;
    crate::updates::admission_unix::admit(&release, arguments)?;
    barrier.check_protection()?;
    let directory = barrier.root.join("managed-runtimes");
    let supervisor = unsafe { libc::getpid() };
    let boot = managed_runtime_context::boot_id()?;
    reconcile(&directory, &boot)?;
    let start = managed_runtime_context::birth(supervisor)?;
    let stem = format!("{}_{supervisor}-{start}", &boot[..8]);
    let socket_name = format!("{stem}.sock");
    let listener = crate::managed_socket::bind(&directory, &socket_name)?;
    fs::set_permissions(directory.join(&socket_name), fs::Permissions::from_mode(0o600)).map_err(|_| refused())?;
    listener.set_nonblocking(true).map_err(|_| refused())?;
    let (pid, gate) = gated_child(&release, &managed_runtime_context::home()?, arguments)?;
    let journal = directory.join(format!("{stem}.json"));
    let creation = (|| {
        let record = Record { protocol_version: 1, boot_id: boot, guard_version: managed_release::GUARD_VERSION,
            supervisor_pid: supervisor, supervisor_started_at: start, child_pid: pid,
            child_started_at: managed_runtime_context::birth(pid)?, release_digest: release.digest.clone(),
            activity: crate::updates::unix_clearance::activity(arguments) };
        publish(&journal, &record)?;
        CHILD.store(pid, Ordering::Relaxed);
        unsafe {
            for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] { libc::signal(signal, forward as *const () as libc::sighandler_t); }
            let byte = 1_u8;
            if libc::write(gate, (&byte as *const u8).cast(), 1) != 1 { return Err(refused()); }
        }
        Ok(record)
    })();
    unsafe { libc::close(gate); }
    drop(barrier);
    let record = match creation { Ok(record) => record, Err(error) => {
        unsafe { libc::kill(-pid, libc::SIGKILL); libc::kill(pid, libc::SIGKILL); libc::waitpid(pid, std::ptr::null_mut(), 0); }
        return Err(error);
    } };
    let mut observed = BTreeMap::<i32, String>::new();
    let mut exited = None;
    let mut settling = Settling::default();
    loop {
        // A snapshot this account cannot verify proves nothing either way, so
        // it never ends supervision: the next one is taken as usual. Ending
        // here left the daemon unsupervised and its journal held for good; on
        // dictator a helper another app started and ended many times a second
        // did that to the team's daemon seconds after every start.
        let snapshot = macos_processes::all();
        if let Ok(processes) = &snapshot { observe(processes, pid, &mut observed); }
        if exited.is_none() {
            let mut status = 0;
            let reaped = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            if reaped == pid {
                CHILD.store(0, Ordering::Relaxed);
                exited = Some(if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) }
                    else if libc::WIFSIGNALED(status) { 128 + libc::WTERMSIG(status) } else { 125 });
            } else if reaped < 0 { return Err(refused()); }
        }
        if let Some(exit) = exited {
            let ended = match &snapshot {
                Ok(processes) if remains(processes, pid, &observed) => Ok(false),
                Ok(_) => {
                    // Group absence alone is not escaped-host tree proof. Its
                    // unresolved admission lease keeps this journal permanently.
                    if unresolved_host(&directory.parent().ok_or_else(refused)?, &record)? { return Err(refused()); }
                    drop_journal(&directory, &journal, &socket_name).map(|()| true)
                }
                Err(error) => Err(NativeError::new(error.code)),
            };
            match ended {
                Ok(true) => return Ok(exit),
                Ok(false) => settling.progressed(),
                Err(error) => if settling.exhausted(std::time::Instant::now()) { return Err(error); },
            }
        }
        if let Ok((stream, _)) = listener.accept() { let _ = probe(stream, &record); }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Adds every live process of the child's tree: its group and descendants of
/// anything already observed, so one that leaves the group is still followed.
fn observe(processes: &[macos_processes::Process], pid: i32, observed: &mut BTreeMap<i32, String>) {
    for process in processes {
        let mut parent = process.parent_pid; let mut depth = 0;
        let mut belongs = process.pid == pid || process.group == pid;
        while !belongs && parent > 1 && depth < processes.len() {
            belongs = parent == pid || observed.contains_key(&parent);
            let Some(ancestor) = processes.iter().find(|item| item.pid == parent) else { break; };
            parent = ancestor.parent_pid; depth += 1;
        }
        if belongs && !process.zombie { observed.insert(process.pid, process.started_at.clone()); }
    }
}

/// Whether any observed generation or member of the child's group still runs.
fn remains(processes: &[macos_processes::Process], pid: i32, observed: &BTreeMap<i32, String>) -> bool {
    observed.iter().any(|(pid, birth)| processes.iter().any(|process|
        process.pid == *pid && process.started_at == *birth && !process.zombie))
        || processes.iter().any(|process| process.group == pid && !process.zombie)
}

fn drop_journal(directory: &Path, journal: &Path, socket_name: &str) -> Result<(), NativeError> {
    let barrier = managed_runtime_context::Barrier::acquire()?;
    fs::remove_file(journal).map_err(|_| refused())?;
    fs::remove_file(directory.join(socket_name)).map_err(|_| refused())?;
    File::open(directory).map_err(|_| refused())?.sync_all().map_err(|_| refused())?;
    drop(barrier);
    Ok(())
}

/// How long an exited runtime may keep failing to verify that its tree ended,
/// or to take the barrier that drops its journal, before it stops and leaves
/// the journal in place. A tree that is still running is waited for as long
/// as it runs; only failures to look count.
const SETTLE_LIMIT: Duration = Duration::from_secs(60);

#[derive(Default)]
struct Settling { failing_since: Option<std::time::Instant> }
impl Settling {
    fn progressed(&mut self) { self.failing_since = None; }
    fn exhausted(&mut self, now: std::time::Instant) -> bool {
        now.duration_since(*self.failing_since.get_or_insert(now)) >= SETTLE_LIMIT
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn creation_record_rejects_unknown_fields() {
        assert!(serde_json::from_value::<Record>(serde_json::json!({"pid":1,"trusted":true})).is_err());
    }

    /// A one-shot `describe` must drop its journal while the team's daemon
    /// holds host registrations of its own, and after a restart.
    #[test]
    fn only_this_childs_host_registrations_in_this_boot_keep_its_journal() {
        let boot = "7035bda9-0000-4000-8000-000000000000";
        let record = Record { protocol_version: 1, boot_id: boot.into(), guard_version: 2, supervisor_pid: 10,
            supervisor_started_at: "1794222097171000".into(), child_pid: 11,
            child_started_at: "1794222097171534".into(), release_digest: "a".repeat(64), activity: None };
        let own = serde_json::json!({"kind":"host_execution","bootId":boot,"pid":11,"startedAt":"1794222097171534"});
        assert!(own_host(&own, &record));
        let mut others = Vec::new();
        for (key, value) in [("pid", serde_json::json!(12)),
            ("bootId", serde_json::json!("ff61df02-d264-4db7-9a2d-2fa908745780")),
            ("startedAt", serde_json::json!("1794222097171535")), ("kind", serde_json::json!("runtime"))] {
            let mut other = own.clone();
            other[key] = value;
            assert!(!own_host(&other, &record), "{key} differs");
            others.push(other);
        }
        let root = tempfile::tempdir().unwrap();
        assert!(!unresolved_host(root.path(), &record).unwrap(), "no guard, nothing to keep");
        let guard = |registrations: &[serde_json::Value]| std::fs::write(root.path().join("guard.json"),
            serde_json::json!({"registrations": registrations}).to_string()).unwrap();
        guard(&others);
        assert!(!unresolved_host(root.path(), &record).unwrap());
        others.push(own);
        guard(&others);
        assert!(unresolved_host(root.path(), &record).unwrap());
    }

    /// The journals the old rule kept clear on the next launch; a live
    /// command's, a daemon's and another boot's stay.
    #[test]
    fn reconcile_drops_only_ended_one_shot_journals_of_this_boot() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("managed-runtimes");
        std::fs::create_dir(&directory).unwrap();
        let boot = managed_runtime_context::boot_id().unwrap();
        let mut ended = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let ended_pid = ended.id() as i32;
        let ended_birth = managed_runtime_context::birth(ended_pid).unwrap();
        ended.wait().unwrap();
        let own = unsafe { libc::getpid() };
        let own_birth = managed_runtime_context::birth(own).unwrap();
        let journal = |name: &str, pid: i32, birth: &str, boot: &str, activity: Option<&str>| {
            let record = Record { protocol_version: 1, boot_id: boot.into(), guard_version: 2, supervisor_pid: pid,
                supervisor_started_at: birth.into(), child_pid: pid, child_started_at: birth.into(),
                release_digest: "a".repeat(64), activity: activity.map(str::to_owned) };
            std::fs::write(directory.join(format!("{name}.json")), serde_json::to_vec(&record).unwrap()).unwrap();
            std::fs::write(directory.join(format!("{name}.sock")), b"").unwrap();
        };
        journal("ended", ended_pid, &ended_birth, &boot, None);
        journal("live", own, &own_birth, &boot, None);
        journal("daemon", ended_pid, &ended_birth, &boot, Some("serve"));
        journal("earlier", ended_pid, &ended_birth, "ff61df02-d264-4db7-9a2d-2fa908745780", None);
        reconcile(&directory, &boot).unwrap();
        let mut left: Vec<_> = std::fs::read_dir(&directory).unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(left, ["daemon.json", "daemon.sock", "earlier.json", "earlier.sock", "live.json", "live.sock"]);
        reconcile(&root.path().join("missing"), &boot).unwrap();
        assert!(macos_processes::live_groups().unwrap().contains(&unsafe { libc::getpgrp() }),
            "the all-account snapshot sees this live group");
    }

    /// A child pid that a new process now holds, leading its own live group,
    /// does not keep an ended command's journal; the same live leader recorded
    /// as the child itself does.
    #[test]
    fn a_reused_child_pid_does_not_hold_an_ended_journal() {
        use std::os::unix::process::CommandExt;
        let root = tempfile::tempdir().unwrap();
        let boot = managed_runtime_context::boot_id().unwrap();
        let mut leader = std::process::Command::new("/bin/sleep").arg("30").process_group(0).spawn().unwrap();
        let pid = leader.id() as i32;
        let birth = managed_runtime_context::birth(pid).unwrap();
        let groups = macos_processes::live_groups().unwrap();
        assert!(groups.contains(&pid), "the new process leads its own live group");
        let record = |started: &str| Record { protocol_version: 1, boot_id: boot.clone(), guard_version: 2,
            supervisor_pid: pid, supervisor_started_at: "1".into(), child_pid: pid, child_started_at: started.into(),
            release_digest: "a".repeat(64), activity: None };
        assert!(ended_one_shot(&record("1"), root.path(), &groups).unwrap(), "an earlier holder of this pid");
        assert!(!ended_one_shot(&record(&birth), root.path(), &groups).unwrap(), "the live child itself");
        leader.kill().unwrap();
        leader.wait().unwrap();
    }
    /// A descendant that left the child's group is still the tree's, and the
    /// tree has ended once its last live member has.
    #[test]
    fn the_tree_is_followed_out_of_its_group_until_its_last_member_ends() {
        let process = |pid: i32, parent: i32, group: i32, zombie: bool| macos_processes::Process { pid,
            parent_pid: parent, group, uid: 501, started_at: pid.to_string(), executable: "/bin/sh".into(), zombie };
        let mut observed = BTreeMap::new();
        observe(&[process(10, 1, 10, false), process(11, 10, 11, false), process(12, 11, 12, false),
            process(20, 1, 20, false)], 10, &mut observed);
        assert_eq!(observed.keys().copied().collect::<Vec<_>>(), [10, 11, 12]);
        assert!(remains(&[process(12, 1, 12, false), process(20, 1, 20, false)], 10, &observed));
        assert!(remains(&[process(30, 1, 10, false)], 10, &observed), "a member of the child's group");
        assert!(!remains(&[process(12, 1, 12, true), process(20, 1, 20, false)], 10, &observed));
        let mut reused = process(12, 1, 12, false);
        reused.started_at = "later".into();
        assert!(!remains(&[reused], 10, &observed), "another process now holds the pid");
    }

    /// Only a minute of failing to look ends an exited runtime's supervision;
    /// any look that saw its tree starts the minute again.
    #[test]
    fn only_a_minute_of_failures_to_look_ends_settling() {
        let start = std::time::Instant::now();
        let mut settling = Settling::default();
        assert!(!settling.exhausted(start));
        assert!(!settling.exhausted(start + SETTLE_LIMIT - Duration::from_millis(1)));
        settling.progressed();
        assert!(!settling.exhausted(start + SETTLE_LIMIT));
        assert!(settling.exhausted(start + SETTLE_LIMIT * 2));
    }
    #[test]
    fn unsigned_process_never_creates_a_managed_child() {
        assert!(run(&["describe".into()]).is_err());
    }
    fn fixture() -> (tempfile::TempDir, managed_release::Release) {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("nessie-executor.cjs"), "printf started > \"$1\"\n").unwrap();
        let release = managed_release::Release { directory: directory.path().into(), digest: "a".repeat(64),
            node: File::open("/bin/sh").unwrap(), node_digest: "b".repeat(64), handles: Vec::new(),
            version: None, source_commit: None };
        (directory, release)
    }
    #[test]
    fn actual_child_cannot_execute_before_publication_and_eof_refuses_it() {
        let (directory, release) = fixture();
        let marker = directory.path().join("not-started");
        let (pid, gate) = gated_child(&release, directory.path(), &[marker.display().to_string()]).unwrap();
        assert!(!managed_runtime_context::birth(pid).unwrap().is_empty());
        assert!(!marker.exists());
        unsafe { libc::close(gate); }
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        assert!(libc::WIFEXITED(status)); assert_eq!(libc::WEXITSTATUS(status), 125);
        assert!(!marker.exists());
    }
    #[test]
    fn actual_child_runs_only_after_creation_gate() {
        let (directory, release) = fixture();
        let marker = directory.path().join("started");
        let (pid, gate) = gated_child(&release, directory.path(), &[marker.display().to_string()]).unwrap();
        assert!(!marker.exists());
        unsafe { let byte = 1_u8; assert_eq!(libc::write(gate, (&byte as *const u8).cast(), 1), 1); libc::close(gate); }
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        assert!(libc::WIFEXITED(status)); assert_eq!(libc::WEXITSTATUS(status), 0);
        assert_eq!(fs::read_to_string(marker).unwrap(), "started");
    }
}
