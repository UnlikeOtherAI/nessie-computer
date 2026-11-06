//! Fresh native-parent probes distinguish restarted daemons from newer files.
use super::{host::root, unix_clearance, unix_package, unix_process::{self, Process}, unix_runtime::{self, ERROR}};
use crate::managed_runtime::Record;
use nessie_executor_updater::{catalog::UpdateResult, protocol::Manifest, storage::Store};
use std::{io::{Read, Write}, os::{fd::AsRawFd, unix::net::UnixStream}, path::Path};

pub(super) fn peer(stream: &UnixStream) -> UpdateResult<Process> {
    #[cfg(target_os = "linux")]
    let (pid, uid) = {
        let mut credential: libc::ucred = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        if unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED,
            (&mut credential as *mut libc::ucred).cast(), &mut size) } != 0
            || size as usize != std::mem::size_of::<libc::ucred>() { return Err(ERROR); }
        (credential.pid, credential.uid)
    };
    #[cfg(target_os = "macos")]
    let (pid, uid) = {
        let mut uid = u32::MAX; let mut gid = u32::MAX; let mut pid = 0_i32;
        let mut size = std::mem::size_of::<i32>() as libc::socklen_t;
        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0
            || unsafe { libc::getsockopt(stream.as_raw_fd(), 0, 2, (&mut pid as *mut i32).cast(), &mut size) } != 0
            || size as usize != std::mem::size_of::<i32>() { return Err(ERROR); }
        (pid, uid)
    };
    let process = unix_process::information(pid)?.ok_or(ERROR)?;
    if process.uid != uid { return Err(ERROR); }
    Ok(process)
}

/// Existing same-user inventory probes remain valid. A Root observer must be
/// the immutable protected native updater, never an elevated Node process.
pub(crate) fn authorize_probe(stream: &UnixStream) -> bool {
    let Ok(process) = peer(stream) else { return false; };
    if process.uid == unsafe { libc::getuid() } { return true; }
    process.uid == 0 && unix_runtime::pin_worker(&process.executable).is_ok()
}

fn probe(root: &Path, uid: u32, record: &Record) -> UpdateResult<Record> {
    let path = root.join("managed-runtimes").join(format!("{}_{}-{}.sock",
        &record.boot_id[..8], record.supervisor_pid, record.supervisor_started_at));
    let mut stream = UnixStream::connect(path).map_err(|_| ERROR)?;
    let timeout = Some(std::time::Duration::from_millis(500));
    stream.set_read_timeout(timeout).and_then(|()| stream.set_write_timeout(timeout)).map_err(|_| ERROR)?;
    let owner = peer(&stream)?;
    let release = crate::managed_release::installed().map_err(|_| ERROR)?;
    if owner.uid != uid || owner.pid != record.supervisor_pid || owner.started_at != record.supervisor_started_at
        || owner.executable != release.directory.join("nessie-executor-native") { return Err(ERROR); }
    #[cfg(target_os = "macos")]
    crate::macos_provenance::require_process(owner.pid).map_err(|_| ERROR)?;
    // Randomness is kernel supplied; this is a live challenge, not a disk receipt.
    let mut random = [0_u8; 32];
    #[cfg(target_os = "linux")]
    std::fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut random)).map_err(|_| ERROR)?;
    #[cfg(target_os = "macos")]
    unsafe { libc::arc4random_buf(random.as_mut_ptr().cast(), random.len()); }
    let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    stream.write_all(format!("{nonce}\n").as_bytes()).map_err(|_| ERROR)?;
    let mut bytes = Vec::new(); stream.take(8193).read_to_end(&mut bytes).map_err(|_| ERROR)?;
    if bytes.len() > 8192 { return Err(ERROR); }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
    if value["nonce"] != nonce { return Err(ERROR); }
    let actual: Record = serde_json::from_value(value["record"].clone()).map_err(|_| ERROR)?;
    if serde_json::to_value(&actual).map_err(|_| ERROR)? != serde_json::to_value(record).map_err(|_| ERROR)?
        || !unix_process::same_generation(&owner)? { return Err(ERROR); }
    Ok(actual)
}

pub(super) fn capture() -> UpdateResult<()> {
    let store = Store::new(root()?);
    let Some(pending) = store.journal()?.pending else { return Ok(()); };
    if store.restart_observation()?.is_some_and(|value| value["transaction"] == pending.digest) { return Ok(()); }
    let mut had_daemon = false;
    for (uid, root) in unix_clearance::roots()? {
        for record in unix_clearance::records(uid, &root)? {
            if unix_process::information(record.child_pid)?.is_some_and(|child| child.started_at == record.child_started_at) {
                let actual = probe(&root, uid, &record)?;
                if matches!(actual.activity.as_deref(), Some("serve" | "serve-direct-local-inference")) { had_daemon = true; }
            }
        }
    }
    store.save_restart_observation(&serde_json::json!({"transaction":pending.digest,"hadDaemon":had_daemon}))
}

pub(super) fn observe(stream: &UnixStream) -> UpdateResult<()> {
    unix_runtime::privileged()?;
    let caller = peer(stream)?;
    if caller.executable.file_name().and_then(|name| name.to_str()) != Some("nessie-executor-native") { return Err(ERROR); }
    let parent = unix_process::information(caller.parent)?.ok_or(ERROR)?;
    if parent.executable.file_name().and_then(|name| name.to_str()) != Some("nessie-executor-runtime") { return Err(ERROR); }
    let release = crate::managed_release::installed().map_err(|_| ERROR)?;
    if caller.executable != release.directory.join("nessie-executor-native") { return Err(ERROR); }
    if parent.uid != caller.uid || parent.executable != release.directory.join("nessie-executor-runtime") { return Err(ERROR); }
    for (uid, root) in unix_clearance::roots()?.into_iter().filter(|(uid, _)| *uid == caller.uid) {
        for record in unix_clearance::records(uid, &root)? {
            if record.child_pid != parent.pid || record.child_started_at != parent.started_at
                || record.release_digest != release.digest { continue; }
            let actual = probe(&root, uid, &record)?;
            if !matches!(actual.activity.as_deref(), Some("serve" | "serve-direct-local-inference")) { continue; }
            if !unix_process::same_generation(&parent)? { return Err(ERROR); }
            return Store::new(super::host::root()?).save_health(&serde_json::json!({
                "format":1,"sourceCommit":release.source_commit,"releaseDigest":release.digest,"generation":parent,
            }));
        }
    }
    Err(ERROR)
}

pub(super) fn confirm_restarted(manifest: &Manifest) -> UpdateResult<bool> {
    let release = crate::managed_release::installed().map_err(|_| ERROR)?;
    if release.version.as_deref() != Some(&manifest.version) || release.source_commit.as_deref() != Some(&manifest.source_commit) { return Ok(false); }
    let store = Store::new(root()?);
    let pending = store.journal()?.pending.ok_or(ERROR)?;
    let observation = store.restart_observation()?.ok_or(ERROR)?;
    if observation["transaction"] != pending.digest { return Ok(false); }
    let healthy = if observation["hadDaemon"] == true {
        let path = root()?.join("healthy.json");
        let value: serde_json::Value = match std::fs::read(path) {
            Ok(bytes) if bytes.len() <= 16_384 => serde_json::from_slice(&bytes).map_err(|_| ERROR)?,
            _ => return Ok(false),
        };
        let generation: Process = serde_json::from_value(value["generation"].clone()).map_err(|_| ERROR)?;
        value["releaseDigest"] == release.digest && value["sourceCommit"] == manifest.source_commit
            && unix_process::same_generation(&generation)?
    } else if observation["hadDaemon"] == false {
        let mut command = unix_package::command(release.directory.join("nessie-executor-native").to_str().ok_or(ERROR)?);
        command.arg("build-info");
        let value: serde_json::Value = serde_json::from_str(&unix_package::inspect(command, None)?).map_err(|_| ERROR)?;
        value["version"] == manifest.version && value["sourceCommit"] == manifest.source_commit
            && value["managedLaunchProtocol"] == 1 && value["personalInferenceGuardVersion"] == 2
    } else { false };
    if !healthy { return Ok(false); }
    #[cfg(target_os = "macos")]
    if !super::macos_applications::confirmed(&manifest.source_commit)? { return Ok(false); }
    let _barrier = crate::managed_machine_barrier::MachineBarrier::acquire().map_err(|_| "update.admission_busy")?;
    let mut state = super::admission_unix::read()?;
    #[cfg(target_os = "macos")]
    super::macos_applications::complete()?;
    state.target = None;
    super::admission_unix::write(&state)?;
    Ok(true)
}
