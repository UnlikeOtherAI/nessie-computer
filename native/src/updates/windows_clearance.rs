//! Live kernel inventory supplements the service journal before replacement.
//! The admission lock is held by the caller; no observed process is stopped.
use nessie_executor_updater::catalog::UpdateResult;
use nessie_windows_common::{
    process::{self, Process},
    update_runtime,
};
use std::collections::BTreeMap;

const PIN: Option<&str> = option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");
const ERROR: &str = "update.custody_unverified";

pub(super) fn ready() -> UpdateResult<bool> {
    let snapshot = process::snapshot().map_err(|_| ERROR)?;
    let by_pid: BTreeMap<_, _> = snapshot.iter().map(|entry| (entry.pid, entry)).collect();
    let mut retained = Vec::new();
    for entry in &snapshot {
        let name = entry.name.to_ascii_lowercase();
        let parent_is_product = by_pid
            .get(&entry.parent)
            .is_some_and(|parent| parent.name.to_ascii_lowercase().contains("nessie"));
        if !name.contains("nessie") && !(name == "node.exe" && parent_is_product) {
            continue;
        }
        let process = Process::open(entry.pid).map_err(|_| ERROR)?;
        if name == "nessie-computer-updater.exe" {
            update_runtime::verify_process(&process, PIN).map_err(|_| ERROR)?;
        } else if matches!(
            name.as_str(),
            "nessie-executor-service.exe"
                | "nessie-executor-tray.exe"
                | "nessie.exe"
                | "nessie-desktop.exe"
        ) {
            // Native shells contain no provider runtime. Every Node,
            // credential actor, helper and VM bridge must have exited instead.
            process.signed(PIN).map_err(|_| ERROR)?;
        } else {
            return Ok(false);
        }
        retained.push(process);
    }
    if retained.iter().any(|process| !process.alive()) {
        return Ok(false);
    }
    let second = process::snapshot().map_err(|_| ERROR)?;
    let relevant = |entries: &[process::Entry]| {
        let parents: BTreeMap<_, _> = entries.iter().map(|entry| (entry.pid, entry)).collect();
        entries
            .iter()
            .filter(|entry| {
                entry.name.to_ascii_lowercase().contains("nessie")
                    || (entry.name.eq_ignore_ascii_case("node.exe")
                        && parents.get(&entry.parent).is_some_and(|parent| {
                            parent.name.to_ascii_lowercase().contains("nessie")
                        }))
            })
            .map(|entry| (entry.pid, entry.parent))
            .collect::<std::collections::BTreeSet<_>>()
    };
    Ok(relevant(&snapshot) == relevant(&second))
}
