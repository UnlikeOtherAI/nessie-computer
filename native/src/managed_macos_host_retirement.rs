//! Native proof that a guard admission's controller cannot receive Nessie work.
//! This is owner-account custody, not proof that arbitrary escaped programs ended.
use crate::{managed_macos_closure, managed_release, managed_runtime_context, macos_processes,
    managed_runtime::Record, protocol::NativeError};
use serde::Serialize;
use std::{fs::OpenOptions, os::unix::fs::{MetadataExt, OpenOptionsExt}, path::Path};

fn refused() -> NativeError { NativeError::new("EXECUTOR_MANAGED_INVENTORY_UNVERIFIED") }

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Controller {
    pid: i32, started_at: String, boot_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    journal: Option<Record>,
}

/// Held launch barriers prevent a managed controller from appearing between
/// this proof and guard reconciliation. The inventory separately verifies all
/// live Nessie processes. Original journals and admissions remain untouched.
pub(crate) fn collect(root: &Path, journals: &[Record]) -> Result<Vec<Controller>, NativeError> {
    let file = match OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root.join("guard.json")) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(refused()),
    };
    let metadata = file.metadata().map_err(|_| refused())?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::getuid() } || metadata.nlink() != 1
        || metadata.mode() & 0o077 != 0 || metadata.len() > 1024 * 1024 { return Err(refused()); }
    let state: serde_json::Value = serde_json::from_reader(file).map_err(|_| refused())?;
    let registrations = state["registrations"].as_array().ok_or_else(refused)?;
    if registrations.len() > 4096 { return Err(refused()); }
    let boot = managed_runtime_context::boot_id()?;
    let groups = macos_processes::live_groups()?;
    let mut retired = Vec::new();
    for item in registrations {
        if item["kind"] != "host_execution" || item["guardVersion"] != managed_release::GUARD_VERSION
            || item["bootId"].as_str() != Some(boot.as_str()) { continue; }
        let pid = item["pid"].as_i64().and_then(|pid| i32::try_from(pid).ok())
            .filter(|pid| *pid > 0).ok_or_else(refused)?;
        let started = item["startedAt"].as_str().filter(|value| !value.is_empty()
            && value.bytes().all(|byte| byte.is_ascii_digit())).ok_or_else(refused)?;
        if managed_macos_closure::process_group_ended(pid, started, &groups)? {
            let journal = journals.iter().find(|record| record.boot_id == boot
                && record.child_pid == pid && record.child_started_at == started).cloned();
            let controller = Controller { pid, started_at: started.into(), boot_id: boot.clone(), journal };
            if !retired.contains(&controller) { retired.push(controller); }
        }
    }
    Ok(retired)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::{fs::PermissionsExt, process::CommandExt}};

    #[test]
    fn only_ended_controller_generations_are_attested_without_deleting_the_guard() {
        let root = tempfile::tempdir().unwrap();
        let boot = managed_runtime_context::boot_id().unwrap();
        let mut ended = std::process::Command::new("/bin/sleep").arg("0.05").process_group(0).spawn().unwrap();
        let pid = ended.id() as i32;
        let birth = managed_runtime_context::birth(pid).unwrap();
        ended.wait().unwrap();
        let mut live = std::process::Command::new("/bin/sleep").arg("30").process_group(0).spawn().unwrap();
        let live_pid = live.id() as i32;
        let live_birth = managed_runtime_context::birth(live_pid).unwrap();
        let item = |pid, started: &str, boot: &str| serde_json::json!({"kind":"host_execution",
            "guardVersion":managed_release::GUARD_VERSION,"pid":pid,"startedAt":started,"bootId":boot});
        let state = serde_json::json!({"registrations":[item(pid,&birth,&boot),item(pid,&birth,&boot),
            item(live_pid,&live_birth,&boot),item(pid,&birth,"ff61df02-d264-4db7-9a2d-2fa908745780")]});
        let path = root.path().join("guard.json");
        let bytes = serde_json::to_vec(&state).unwrap();
        fs::write(&path, &bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let journal = Record { protocol_version: 1, guard_version: managed_release::GUARD_VERSION,
            boot_id: boot.clone(), supervisor_pid: pid, supervisor_started_at: birth.clone(), child_pid: pid,
            child_started_at: birth.clone(), release_digest: "a".repeat(64), activity: Some("serve".into()) };
        let result = collect(root.path(), &[journal.clone()]);
        live.kill().unwrap(); live.wait().unwrap();
        assert_eq!(result.unwrap(), vec![Controller { pid, started_at: birth, boot_id: boot, journal: Some(journal) }]);
        assert_eq!(fs::read(path).unwrap(), bytes, "native proof never rewrites admission history");
    }

    #[test]
    fn unreadable_guard_never_becomes_retirement_evidence() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("guard.json");
        fs::write(&path, b"not json").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(collect(root.path(), &[]).is_err());
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink("/dev/null", &path).unwrap();
        assert!(collect(root.path(), &[]).is_err());
    }
}
