//! A per-launch native parent retains creation evidence for a fixed release.
//! This is lifetime/provenance machinery, not credential-inaccessible isolation.
use crate::{managed_release, managed_runtime_context, protocol::NativeError};
use serde::{Deserialize, Serialize};
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::Duration;

fn refused() -> NativeError {
    NativeError::new("EXECUTOR_MANAGED_LAUNCH_REJECTED")
}
static CHILD: AtomicI32 = AtomicI32::new(0);
extern "C" fn forward(signal: i32) {
    let pid = CHILD.load(Ordering::Relaxed);
    if pid > 0 {
        unsafe {
            libc::kill(pid, signal);
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub protocol_version: u32,
    pub boot_id: String,
    pub guard_version: u32,
    pub supervisor_pid: i32,
    pub supervisor_started_at: String,
    pub child_pid: i32,
    pub child_started_at: String,
    pub release_digest: String,
}

fn publish(path: &Path, record: &Record) -> Result<(), NativeError> {
    let draft = path.with_extension("draft");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(if unsafe { libc::getuid() } == 0 {
            0o644
        } else {
            0o600
        })
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&draft)
        .map_err(|_| refused())?;
    if unsafe { libc::getuid() } == 0 {
        file.set_permissions(fs::Permissions::from_mode(0o644))
            .map_err(|_| refused())?;
    }
    let bytes = serde_json::to_vec(record).map_err(|_| refused())?;
    file.write_all(&bytes).map_err(|_| refused())?;
    file.sync_all().map_err(|_| refused())?;
    fs::rename(&draft, path).map_err(|_| refused())?;
    File::open(path.parent().ok_or_else(refused)?)
        .map_err(|_| refused())?
        .sync_all()
        .map_err(|_| refused())
}

fn peer(stream: &UnixStream) -> Result<libc::ucred, NativeError> {
    let mut credential = std::mem::MaybeUninit::<libc::ucred>::uninit();
    let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            credential.as_mut_ptr().cast(),
            &mut size,
        )
    } != 0
        || size as usize != std::mem::size_of::<libc::ucred>()
    {
        return Err(refused());
    }
    Ok(unsafe { credential.assume_init() })
}

fn probe(mut stream: UnixStream, record: &Record) -> Result<(), NativeError> {
    if peer(&stream)?.uid != unsafe { libc::getuid() } {
        return Err(refused());
    }
    stream
        .set_read_timeout(Some(Duration::from_millis(250)))
        .map_err(|_| refused())?;
    stream
        .set_write_timeout(Some(Duration::from_millis(250)))
        .map_err(|_| refused())?;
    let mut nonce = [0_u8; 65];
    stream.read_exact(&mut nonce).map_err(|_| refused())?;
    if nonce[64] != b'\n' || !nonce[..64].iter().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(refused());
    }
    let nonce = std::str::from_utf8(&nonce[..64]).map_err(|_| refused())?;
    let reply = serde_json::json!({ "nonce": nonce, "record": record });
    stream
        .write_all(&serde_json::to_vec(&reply).map_err(|_| refused())?)
        .map_err(|_| refused())
}

fn gated_child(
    release: &managed_release::Release,
    home: &Path,
    arguments: &[String],
) -> Result<(i32, i32), NativeError> {
    let node = release.directory.join("nessie-executor-runtime");
    let bundle = release.directory.join("nessie-executor.cjs");
    let mut values = vec![
        CString::new(node.as_os_str().as_bytes()).map_err(|_| refused())?,
        CString::new(bundle.as_os_str().as_bytes()).map_err(|_| refused())?,
    ];
    for argument in arguments {
        values.push(CString::new(argument.as_bytes()).map_err(|_| refused())?);
    }
    let mut argv: Vec<*const libc::c_char> = values.iter().map(|value| value.as_ptr()).collect();
    argv.push(std::ptr::null());
    let environment: Vec<CString> = managed_release::environment(home)
        .into_iter()
        .map(|(name, value)| {
            let mut bytes = name.as_bytes().to_vec();
            bytes.push(b'=');
            bytes.extend_from_slice(value.as_bytes());
            CString::new(bytes).map_err(|_| refused())
        })
        .collect::<Result<_, _>>()?;
    let mut envp: Vec<*const libc::c_char> =
        environment.iter().map(|value| value.as_ptr()).collect();
    envp.push(std::ptr::null());
    let mut gate = [-1; 2];
    if unsafe { libc::pipe2(gate.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(refused());
    }
    let parent = unsafe { libc::getpid() };
    // No threads exist yet. The child executes only async-signal-safe syscalls
    // until fexecve; all argv/environment allocation happened above.
    let pid = unsafe { libc::fork() };
    if pid == 0 {
        unsafe {
            libc::close(gate[1]);
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 || libc::getppid() != parent
            {
                libc::_exit(125);
            }
            let mut ready = 0_u8;
            if libc::read(gate[0], (&mut ready as *mut u8).cast(), 1) != 1 || ready != 1 {
                libc::_exit(125);
            }
            libc::close(gate[0]);
            libc::fexecve(release.node.as_raw_fd(), argv.as_ptr(), envp.as_ptr());
            libc::_exit(125);
        }
    }
    unsafe {
        libc::close(gate[0]);
    }
    if pid < 0 {
        unsafe {
            libc::close(gate[1]);
        }
        return Err(refused());
    }
    Ok((pid, gate[1]))
}

pub fn run(arguments: &[String]) -> Result<i32, NativeError> {
    let release = managed_release::load()?;
    let barrier = managed_runtime_context::Barrier::acquire()?;
    barrier.check_protection()?;
    // Kernel reparents living descendants to this retained parent. Its exit
    // code is not tree-stop proof: the durable record stays until every child
    // has been reaped, including descendants surviving the Node entry.
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1) } != 0 {
        return Err(refused());
    }
    let supervisor = unsafe { libc::getpid() };
    let started = managed_runtime_context::birth(supervisor)?;
    let directory = barrier.root.join("managed-runtimes");
    let boot = managed_runtime_context::boot_id()?;
    let stem = format!("{}_{supervisor}-{started}", &boot[..8]);
    let socket_name = format!("{stem}.sock");
    let socket = directory.join(&socket_name);
    let journal = directory.join(format!("{stem}.json"));
    let listener = crate::managed_socket::bind(&directory, &socket_name)?;
    listener.set_nonblocking(true).map_err(|_| refused())?;
    let (pid, gate) = gated_child(&release, &managed_runtime_context::home()?, arguments)?;
    let creation = (|| {
        let record = Record {
            protocol_version: 1,
            boot_id: managed_runtime_context::boot_id()?,
            guard_version: managed_release::GUARD_VERSION,
            supervisor_pid: supervisor,
            supervisor_started_at: started,
            child_pid: pid,
            child_started_at: managed_runtime_context::birth(pid)?,
            release_digest: release.digest.clone(),
        };
        publish(&journal, &record)?;
        CHILD.store(pid, Ordering::Relaxed);
        unsafe {
            libc::signal(libc::SIGTERM, forward as *const () as libc::sighandler_t);
            libc::signal(libc::SIGINT, forward as *const () as libc::sighandler_t);
            libc::signal(libc::SIGHUP, forward as *const () as libc::sighandler_t);
            let ready = 1_u8;
            if libc::write(gate, (&ready as *const u8).cast(), 1) != 1 {
                return Err(refused());
            }
        }
        Ok(record)
    })();
    unsafe {
        libc::close(gate);
    }
    drop(barrier);
    let record = match creation {
        Ok(record) => record,
        Err(error) => {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
                libc::waitpid(pid, std::ptr::null_mut(), 0);
            }
            return Err(error);
        }
    };
    // Retained handles are live provenance, not reopen-and-hash claims.
    let _retained_release = (&release.node, &release.handles);
    let mut exit = 125;
    loop {
        let mut status = 0;
        let reaped = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if reaped == pid {
            CHILD.store(0, Ordering::Relaxed);
            exit = if libc::WIFEXITED(status) {
                libc::WEXITSTATUS(status)
            } else if libc::WIFSIGNALED(status) {
                128 + libc::WTERMSIG(status)
            } else {
                125
            };
        } else if reaped < 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD) {
                break;
            }
            return Err(refused()); // Preserve the journal on uncertain tree observation.
        }
        if let Ok((stream, _)) = listener.accept() {
            let _ = probe(stream, &record);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    fs::remove_file(&socket).map_err(|_| refused())?;
    fs::remove_file(&journal).map_err(|_| refused())?;
    File::open(directory)
        .map_err(|_| refused())?
        .sync_all()
        .map_err(|_| refused())?;
    Ok(exit)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, managed_release::Release) {
        let directory = tempfile::tempdir().unwrap();
        // Test only the kernel creation gate; this is not an installed-release
        // verifier fixture and cannot pass load() in production.
        fs::write(
            directory.path().join("nessie-executor.cjs"),
            "printf started > \"$1\"\n",
        )
        .unwrap();
        let release = managed_release::Release {
            directory: directory.path().to_path_buf(),
            digest: "fixture-only".to_owned(),
            node: File::open("/bin/sh").unwrap(),
            node_digest: "fixture-only".to_owned(),
            version: None,
            source_commit: None,
            handles: Vec::new(),
        };
        (directory, release)
    }

    #[test]
    fn child_cannot_execute_before_publication_gate_and_eof_never_admits_it() {
        let (directory, release) = fixture();
        let marker = directory.path().join("must-not-exist");
        let (pid, gate) = gated_child(
            &release,
            directory.path(),
            &[marker.to_str().unwrap().to_owned()],
        )
        .unwrap();
        assert!(!managed_runtime_context::birth(pid).unwrap().is_empty());
        assert!(!marker.exists());
        unsafe {
            libc::close(gate);
        }
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 125);
        assert!(!marker.exists());
    }

    #[test]
    fn actual_child_executes_only_after_gate_and_observed_exit_provides_status() {
        let (directory, release) = fixture();
        let marker = directory.path().join("started");
        let (pid, gate) = gated_child(
            &release,
            directory.path(),
            &[marker.to_str().unwrap().to_owned()],
        )
        .unwrap();
        assert!(!marker.exists());
        unsafe {
            let ready = 1_u8;
            assert_eq!(libc::write(gate, (&ready as *const u8).cast(), 1), 1);
            libc::close(gate);
        }
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
        assert_eq!(fs::read_to_string(marker).unwrap(), "started");
    }
}
