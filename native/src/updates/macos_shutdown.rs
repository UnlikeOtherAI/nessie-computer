//! Finish a daemon that completed cleanup but retained an idle transport.
//! A live runtime registration, credential fence or unresolved host admission
//! keeps it untouched. SIGTERM is a lifecycle request, never clearance proof.
use super::{unix_clearance, unix_process, unix_runtime};
use crate::{managed_release, macos_provenance, managed_macos_closure, managed_runtime::Record};
use nessie_executor_updater::catalog::UpdateResult;
use std::{fs::OpenOptions, os::unix::fs::{MetadataExt, OpenOptionsExt}, path::Path};

const ERROR: &str = "update.custody_unverified";

fn registration_released(state: &serde_json::Value, record: &Record) -> UpdateResult<bool> {
    if state["version"] != 1 || state.get("protection") != Some(&serde_json::Value::Null) { return Ok(false); }
    let registrations = state["registrations"].as_array().ok_or(ERROR)?;
    if registrations.len() > 4096 { return Err(ERROR); }
    Ok(!registrations.iter().any(|item| item["pid"].as_i64() == Some(record.child_pid.into())
        && item["startedAt"].as_str() == Some(record.child_started_at.as_str())
        && item["bootId"].as_str() == Some(record.boot_id.as_str())
        && item["kind"] != "host_execution"))
}

fn released(uid: u32, root: &Path, record: &Record) -> UpdateResult<bool> {
    let file = match OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root.join("guard.json")) {
        Ok(file) => file,
        Err(_) => return Ok(false),
    };
    let metadata = file.metadata().map_err(|_| ERROR)?;
    if !metadata.is_file() || metadata.uid() != uid || metadata.nlink() != 1
        || metadata.mode() & 0o077 != 0 || metadata.len() > 1024 * 1024 { return Err(ERROR); }
    let state: serde_json::Value = serde_json::from_reader(file).map_err(|_| ERROR)?;
    if !registration_released(&state, record)? { return Ok(false); }
    let groups = crate::macos_processes::live_groups().map_err(|_| ERROR)?;
    Ok(!managed_macos_closure::unresolved_host(root, record, &groups).map_err(|_| ERROR)?)
}

/// Called only by application adoption under the machine launch barrier.
/// Serve registers before accepting work and releases after all cleanup.
/// The helper never signals a daemon that still holds that registration.
pub(super) fn request_completed() -> UpdateResult<()> {
    unix_runtime::privileged()?;
    for (uid, root) in unix_clearance::roots()? {
        for record in unix_clearance::records(uid, &root)? {
            if record.activity.as_deref() != Some("serve") || !released(uid, &root, &record)? { continue; }
            let Some(child) = unix_process::information(record.child_pid)? else { continue; };
            let Some(parent) = unix_process::information(record.supervisor_pid)? else { continue; };
            if child.uid != uid || parent.uid != uid || child.parent != parent.pid
                || child.started_at != record.child_started_at || parent.started_at != record.supervisor_started_at { continue; }
            let release = managed_release::retained(&record.release_digest).map_err(|_| ERROR)?;
            if child.executable != release.directory.join("nessie-executor-runtime")
                || parent.executable != release.directory.join("nessie-executor-native") { continue; }
            macos_provenance::require_process(child.pid).map_err(|_| ERROR)?;
            macos_provenance::require_process(parent.pid).map_err(|_| ERROR)?;
            if !released(uid, &root, &record)? || !unix_process::same_generation(&child)?
                || !unix_process::same_generation(&parent)? { continue; }
            // No signal escalation, journal deletion or assumed termination.
            // The normal inventory must independently observe both processes gone.
            if unsafe { libc::kill(parent.pid, libc::SIGTERM) } != 0
                && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) { return Err(ERROR); }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn active_or_unknown_runtime_and_credential_custody_never_become_stop_requests() {
        let record = Record { protocol_version: 1, guard_version: 2, boot_id: "boot".into(),
            supervisor_pid: 10, supervisor_started_at: "100".into(), child_pid: 11,
            child_started_at: "200".into(), release_digest: "a".repeat(64), activity: Some("serve".into()) };
        let registration = |kind: &str| serde_json::json!({"pid":11,"startedAt":"200","bootId":"boot","kind":kind});
        for kind in ["runtime", "credential_runtime", "unknown"] {
            assert!(!registration_released(&serde_json::json!({"version":1,"protection":null,"registrations":[registration(kind)]}), &record).unwrap());
        }
        assert!(registration_released(&serde_json::json!({"version":1,"protection":null,"registrations":[]}), &record).unwrap());
        assert!(!registration_released(&serde_json::json!({"version":1,"protection":{},"registrations":[]}), &record).unwrap());
        assert!(registration_released(&serde_json::json!({"version":1,"protection":null}), &record).is_err());
    }
}
