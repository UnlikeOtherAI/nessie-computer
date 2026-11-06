//! Remember whether the drained installation had a running executor daemon.
use super::runtime::{runtime, service_root, ERROR};
use crate::updates::host::root;
use nessie_executor_updater::{catalog::UpdateResult, protocol::Manifest, storage::Store};
use nessie_windows_common::{custody::RuntimeKind, custody_observation::absent, custody_store::Store as CustodyStore};
use std::{io::Read, os::windows::process::CommandExt, process::{Command, Stdio}, time::{Duration, Instant}};

/// Called under the persistent native admission lock before old runtimes exit.
pub(in crate::updates) fn capture() -> UpdateResult<()> {
    let store = Store::new(root()?);
    let journal = store.journal()?;
    let Some(pending) = journal.pending else { return Ok(()); };
    if store.restart_observation()?.is_some_and(|value| value["transaction"] == pending.digest) { return Ok(()); }
    let state = CustodyStore::new(&service_root()?).read().map_err(|_| ERROR)?;
    let mut had_daemon = false;
    for record in state.runtimes.values() {
        if matches!(record.kind, RuntimeKind::ServiceDaemon | RuntimeKind::UserDaemon)
            && !absent(&record.child).map_err(|_| ERROR)? { had_daemon = true; }
    }
    store.save_restart_observation(&serde_json::json!({
        "transaction":pending.digest, "hadDaemon":had_daemon,
    }))
}

pub(super) fn native_only(manifest: &Manifest) -> UpdateResult<bool> {
    let store = Store::new(root()?);
    let pending = store.journal()?.pending.ok_or(ERROR)?;
    let observation = store.restart_observation()?.ok_or(ERROR)?;
    if observation["transaction"] != pending.digest || observation["hadDaemon"] != false { return Ok(false); }
    // An unpaired or deliberately stopped installation has no daemon to report
    // health. Run the exact signed native image and inspect its compiled facts;
    // privileged code never starts Node as SYSTEM for a health check.
    let release = runtime()?;
    let mut child = Command::new(&release.runtime.native_helper).arg("build-info")
        .env_clear().stdin(Stdio::null()).stderr(Stdio::null()).stdout(Stdio::piped())
        .creation_flags(0x08000000).spawn().map_err(|_| ERROR)?;
    let output = child.stdout.take().ok_or(ERROR)?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        output.take(4097).read_to_end(&mut bytes).map(|_| bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let completed = loop {
        if let Some(status) = child.try_wait().map_err(|_| ERROR)? { break status.success(); }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break false;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let bytes = reader.join().map_err(|_| ERROR)?.map_err(|_| ERROR)?;
    if !completed || bytes.len() > 4096 { return Ok(false); }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
    Ok(value["version"] == manifest.version && value["sourceCommit"] == manifest.source_commit
        && value["managedLaunchProtocol"] == 1 && value["personalInferenceGuardVersion"] == 2)
}
