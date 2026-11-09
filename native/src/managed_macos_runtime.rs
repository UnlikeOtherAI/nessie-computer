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
    loop {
        let processes = macos_processes::all()?;
        for process in &processes {
            let mut parent = process.parent_pid; let mut depth = 0;
            let mut belongs = process.pid == pid || process.group == pid;
            while !belongs && parent > 1 && depth < processes.len() {
                belongs = parent == pid || observed.contains_key(&parent);
                let Some(ancestor) = processes.iter().find(|item| item.pid == parent) else { break; };
                parent = ancestor.parent_pid; depth += 1;
            }
            if belongs && !process.zombie { observed.insert(process.pid, process.started_at.clone()); }
        }
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
            let remaining = observed.iter().any(|(pid, birth)| processes.iter().any(|process|
                process.pid == *pid && process.started_at == *birth && !process.zombie));
            if !remaining && !processes.iter().any(|process| process.group == pid && !process.zombie) {
                // Group absence alone is not escaped-host tree proof. Its
                // unresolved admission lease keeps this journal permanently.
                if unresolved_host(&directory.parent().ok_or_else(refused)?, &record)? { return Err(refused()); }
                let barrier = managed_runtime_context::Barrier::acquire()?;
                fs::remove_file(&journal).map_err(|_| refused())?;
                fs::remove_file(directory.join(&socket_name)).map_err(|_| refused())?;
                File::open(&directory).map_err(|_| refused())?.sync_all().map_err(|_| refused())?;
                drop(barrier); return Ok(exit);
            }
        }
        if let Ok((stream, _)) = listener.accept() { let _ = probe(stream, &record); }
        std::thread::sleep(Duration::from_millis(25));
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
