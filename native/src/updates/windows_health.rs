//! Fresh running daemon confirmation through native creation and kernel generation proof.
use super::runtime::{runtime, service_root, ERROR, PIN};
use crate::updates::host::root;
use nessie_executor_updater::{catalog::UpdateResult, protocol::Manifest};
use nessie_windows_common::{
    custody_store::Store as CustodyStore, process, release, update_admission::Admission,
};
use std::fs;
pub fn confirm_restarted(manifest: &Manifest) -> UpdateResult<bool> {
    let release = runtime()?;
    if release.version.as_deref() != Some(&manifest.version)
        || release.source_commit.as_deref() != Some(&manifest.source_commit)
    {
        return Ok(false);
    }
    // Fresh process confirmation is supplied by the broker after native parent
    // generation and immutable release proof; newer files alone never pass.
    let path = root()?.join("healthy.json");
    let _pin = match release::pin_protected(&path, false) {
        Ok(pin) => pin,
        Err(_) => return Ok(false),
    };
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(path).map_err(|_| ERROR)?).map_err(|_| ERROR)?;
    if value["sourceCommit"] != manifest.source_commit || value["releaseDigest"] != release.digest {
        return Ok(false);
    }
    let generation: nessie_windows_common::custody::Generation =
        serde_json::from_value(value["generation"].clone()).map_err(|_| ERROR)?;
    let process = match process::Process::open(generation.pid) {
        Ok(process) => process,
        Err(_) => return Ok(false),
    };
    if process.generation != generation || !process.alive() {
        return Ok(false);
    }
    Admission::acquire(true)
        .map_err(|_| "update.admission_busy")?
        .set_target(None)
        .map_err(|_| ERROR)?;
    Ok(true)
}

/// The RPC peer is the short-lived native child of a newly running daemon.
/// A CLI, a claimed version, or a matching executable name cannot establish health.
pub(in crate::updates) fn observe_daemon(
    pipe: windows_sys::Win32::Foundation::HANDLE,
) -> UpdateResult<()> {
    use nessie_windows_common::custody::RuntimeKind;
    use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
    let mut pid = 0;
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) } == 0 || pid == 0 {
        return Err(ERROR);
    }
    let caller = process::Process::open(pid).map_err(|_| ERROR)?;
    let release = runtime()?;
    if !caller.alive() || caller.image != release.runtime.native_helper {
        return Err(ERROR);
    }
    caller.signed(PIN).map_err(|_| ERROR)?;
    let parent = process::snapshot()
        .map_err(|_| ERROR)?
        .into_iter()
        .find(|entry| entry.pid == pid)
        .ok_or(ERROR)?
        .parent;
    let parent = process::Process::open(parent).map_err(|_| ERROR)?;
    if !parent.alive()
        || parent.sid != caller.sid
        || parent.image != release.runtime.node_executable
    {
        return Err(ERROR);
    }
    let state = CustodyStore::new(&service_root()?)
        .read()
        .map_err(|_| ERROR)?;
    if !state.runtimes.values().any(|record| {
        record.child == parent.generation
            && record.owner_sid == caller.sid
            && record.release_digest == release.digest
            && matches!(
                record.kind,
                RuntimeKind::ServiceDaemon | RuntimeKind::UserDaemon
            )
    }) {
        return Err(ERROR);
    }
    if !caller.alive() || !parent.alive() {
        return Err(ERROR);
    }
    nessie_executor_updater::storage::Store::new(root()?).save_health(&serde_json::json!({
        "format":1, "sourceCommit":release.source_commit, "releaseDigest":release.digest,
        "generation":parent.generation,
    }))
}
