//! Independent live inventory; cooperative records are evidence, never the process table.
use super::{job_members, PIN};
use crate::custody_store::State;
use nessie_windows_common::{
    custody::{Generation, Record, RuntimeKind, REJECTED},
    process::{self, Process},
};
use std::collections::BTreeMap;

fn runtime_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name == "node.exe" || name.contains("nessie") || name == "electron.exe"
}
fn compatible_service(record: &Record) -> Result<bool, String> {
    let service = nessie_windows_common::service_channel::service_account_sid()?;
    Ok(record.session_id == 0
        && ((record.owner_sid == service
            && matches!(
                record.kind,
                RuntimeKind::ServiceDaemon
                    | RuntimeKind::ServiceControl
                    | RuntimeKind::MachineAttestation
            ))
            || (record.owner_sid == "S-1-5-18" && record.kind == RuntimeKind::MachineAttestation)))
}
fn proven_job_members(state: &State, caller: &Process, record: &Record) -> Result<(), String> {
    let mut known: BTreeMap<u32, &Generation> = BTreeMap::new();
    for record in state.runtimes.values() {
        known.insert(record.supervisor.pid, &record.supervisor);
        known.insert(record.child.pid, &record.child);
    }
    known.insert(caller.generation.pid, &caller.generation);
    let members = job_members(&record.job_name)?;
    if !members.contains(&record.child.pid) {
        return Err(REJECTED.into());
    }
    for pid in members {
        let generation = known.get(&pid).ok_or(REJECTED)?;
        let observed = Process::open(pid)?;
        if &observed.generation != *generation || !observed.alive() {
            return Err(REJECTED.into());
        }
    }
    Ok(())
}

pub(super) fn inventory(
    state: &State,
    caller: &Process,
    release: &str,
) -> Result<Vec<Record>, String> {
    if !state.hosts.is_empty() {
        return Err(REJECTED.into());
    }
    let initial = process::snapshot()?;
    let mut retained = Vec::new();
    for entry in &initial {
        let lower = entry.name.to_ascii_lowercase();
        if lower == "node.exe" || lower.contains("nessie") || lower == "electron.exe" {
            let current = Process::open(entry.pid)?;
            if lower == "nessie-computer-updater.exe" {
                nessie_windows_common::update_runtime::verify_process(&current, PIN)?;
                continue;
            }
            // Service and signed native companion executables contain no
            // provider material. Actual Node children require creation proof.
            if lower == "nessie-executor-service.exe"
                || lower == "nessie-executor-tray.exe"
                || lower == "nessie-executor-native.exe"
            {
                current.signed(PIN)?;
                if nessie_windows_common::release::load_at(&current.image, PIN)?.digest != release {
                    return Err(REJECTED.into());
                }
                if lower == "nessie-executor-native.exe"
                    && entry.pid != caller.generation.pid
                    && !state
                        .runtimes
                        .values()
                        .any(|record| record.supervisor == current.generation)
                {
                    return Err(REJECTED.into());
                }
            } else {
                let record = state
                    .runtimes
                    .values()
                    .find(|record| {
                        record.child == current.generation
                            && record.supervisor.pid == entry.parent
                            && record.release_digest == release
                    })
                    .ok_or(REJECTED)?;
                proven_job_members(state, caller, record)?;
                if (record.owner_sid != caller.sid || record.session_id == 0)
                    && !compatible_service(record)?
                {
                    return Err(REJECTED.into());
                }
            }
            retained.push(current);
        }
    }
    let after = process::snapshot()?;
    let mut before_names: Vec<_> = initial
        .iter()
        .filter(|entry| runtime_name(&entry.name))
        .map(|entry| (entry.pid, entry.parent, &entry.name))
        .collect();
    let mut after_names: Vec<_> = after
        .iter()
        .filter(|entry| runtime_name(&entry.name))
        .map(|entry| (entry.pid, entry.parent, &entry.name))
        .collect();
    before_names.sort_unstable();
    after_names.sort_unstable();
    if before_names != after_names {
        return Err(REJECTED.into());
    }
    if retained.iter().any(|process| {
        !process.alive()
            || !after
                .iter()
                .any(|entry| entry.pid == process.generation.pid)
    }) {
        return Err(REJECTED.into());
    }
    // Every creation row is checked against the kernel too, regardless of its
    // name in the process table. An old/elevated or another-owner runtime blocks.
    let records: Vec<Record> = state.runtimes.values().cloned().collect();
    if !records.iter().any(|record| {
        record.child.pid
            == initial
                .iter()
                .find(|entry| entry.pid == caller.generation.pid)
                .map_or(0, |entry| entry.parent)
    }) || records.iter().any(|record| {
        ((record.owner_sid != caller.sid || record.session_id == 0)
            && !compatible_service(record).unwrap_or(false))
            || record.release_digest != release
            || proven_job_members(state, caller, record).is_err()
    }) {
        return Err(REJECTED.into());
    }
    Ok(records)
}

/// A proven token-free daemon can remain; every credential actor/controller,
/// uncertain managed job and unknown native helper still requires positive exit.
pub(super) fn credential_clearance(
    state: &State,
    caller: &Process,
    release: &str,
) -> Result<(), String> {
    if !state.holds.is_empty()
        || state
            .hosts
            .values()
            .any(|host| host.owner_sid == caller.sid)
    {
        return Err(REJECTED.into());
    }
    for record in state.runtimes.values() {
        let safe = (record.owner_sid == caller.sid
            && record.session_id != 0
            && record.kind == RuntimeKind::UserDaemon)
            || compatible_service(record)?;
        if !safe || record.release_digest != release {
            return Err(REJECTED.into());
        }
        proven_job_members(state, caller, record)?;
        let supervisor = Process::open(record.supervisor.pid)?;
        if supervisor.generation != record.supervisor || !supervisor.alive() {
            return Err(REJECTED.into());
        }
        supervisor.signed(PIN)?;
    }
    for entry in process::snapshot()? {
        if entry.pid == caller.generation.pid || !runtime_name(&entry.name) {
            continue;
        }
        let process = Process::open(entry.pid)?;
        let name = entry.name.to_ascii_lowercase();
        if name == "nessie-computer-updater.exe" {
            nessie_windows_common::update_runtime::verify_process(&process, PIN)?;
            continue;
        }
        if name == "nessie-executor-tray.exe" || name == "nessie-executor-service.exe" {
            process.signed(PIN)?;
            if nessie_windows_common::release::load_at(&process.image, PIN)?.digest != release {
                return Err(REJECTED.into());
            }
            continue;
        }
        if !state.runtimes.values().any(|record| {
            record.child == process.generation || record.supervisor == process.generation
        }) {
            return Err(REJECTED.into());
        }
    }
    Ok(())
}
