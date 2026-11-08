//! Service-wide managed creation and public persistent admission, independently observed.
use crate::custody_store::{Host, State, Store};
use nessie_windows_common::{
    custody_observation::{absent, job_members},
    custody::RuntimeKind,
    custody::{Operation, Record, REJECTED, VERSION},
    process::{self, Owned, Process},
};
use std::{os::windows::ffi::OsStrExt, path::Path, sync::Mutex};
use windows_sys::Win32::{
    System::{
        JobObjects::{IsProcessInJob, OpenJobObjectW},
        Pipes::GetNamedPipeClientProcessId,
    },
};

// Independent of Supervisor's mutex: a supervised child may call this channel
// while Supervisor waits for its one-shot command to complete.
static ADMISSION: Mutex<()> = Mutex::new(());
const PIN: Option<&str> = option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");
const JOB_OBJECT_QUERY: u32 = 0x0004;
fn reconcile(state: &mut State) -> Result<(), String> {
    let boot = process::boot_id()?;
    for record in state.execution_creations.values_mut(){
        if let (Some(child),Some(job))=(&record.child,&record.job_name){
            if absent(child)?&&job_members(job)?.is_empty(){record.cleared=true;}
        }
    }
    let mut gone = Vec::new();
    for (key, record) in &state.runtimes {
        if record.supervisor.boot_id != boot
            || (job_members(&record.job_name)?.is_empty()
                && absent(&record.child)?
                && absent(&record.supervisor)?)
        {
            gone.push(key.clone());
        }
    }
    for key in gone {
        state.runtimes.remove(&key);
    }
    let mut gone = Vec::new();
    for (key, host) in &state.hosts {
        if host.controller.boot_id != boot
            || (absent(&host.controller)?
                && (job_members(&host.job_name)?.is_empty() && absent(&host.runtime_child)?
                    || host_members_cleared(state, host, None)?))
        {
            gone.push(key.clone());
        }
    }
    for key in gone {
        state.hosts.remove(&key);
    }
    let mut gone = Vec::new();
    for (nonce, hold) in &state.holds {
        if absent(hold)? {
            gone.push(nonce.clone());
        }
    }
    for nonce in gone {
        state.holds.remove(&nonce);
    }
    Ok(())
}
fn host_members_cleared(state: &State, host: &Host, observer: Option<u32>) -> Result<bool, String> {
    let mut allowed = vec![host.runtime_child.pid];
    if let Some(pid) = observer {
        allowed.push(pid);
    }
    for current in state
        .hosts
        .values()
        .filter(|current| current.runtime_child == host.runtime_child)
    {
        if !absent(&current.controller)? {
            allowed.push(current.controller.pid);
        }
    }
    let root = Process::open(host.runtime_child.pid)?;
    if root.generation != host.runtime_child || !root.alive() {
        return Ok(false);
    }
    // Other active native lease holders contain no provider material. Their
    // arbitrary children remain extra kernel job members and prevent release.
    let members = job_members(&host.job_name)?;
    Ok(
        members.contains(&host.runtime_child.pid)
            && members.iter().all(|pid| allowed.contains(pid)),
    )
}
fn owner_registered(root: &Path, sid: &str) -> bool {
    crate::paths::paired_executors(root).into_iter().any(|id| {
        std::fs::read_to_string(
            crate::paths::executors_root(root)
                .join(id)
                .join(crate::paths::PAIRED_BY_FILE),
        )
        .is_ok_and(|value| value.trim() == sid)
    })
}
#[path = "custody_inventory.rs"]
mod live;
use live::inventory;

pub fn handle(
    pipe: windows_sys::Win32::Foundation::HANDLE,
    root: &Path,
    sid: Option<&str>,
    operation: Operation,
) -> Result<serde_json::Value, String> {
    let _lock = ADMISSION.lock().map_err(|_| REJECTED)?;
    let machine = nessie_windows_common::update_admission::Admission::acquire(false)?;
    nessie_windows_common::custody::validate(&operation)?;
    let mut pid = 0;
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) } == 0 || pid == 0 {
        return Err(REJECTED.into());
    }
    let caller = Process::open(pid)?;
    let creator=matches!(&operation,Operation::ExecutionCreator{..});
    if !caller.alive()
        || Some(caller.sid.as_str()) != sid
        || caller.image.file_name().and_then(|value| value.to_str())
            != Some(if creator{"nessie-computer-updater.exe"}else{"nessie-executor-native.exe"})
    {
        return Err(REJECTED.into());
    }
    caller.signed(PIN)?;
    let release = if creator {
        if caller.sid!="S-1-5-18"||caller.session!=0{return Err(REJECTED.into());}
        let _pins=nessie_windows_common::update_runtime::pin_image(&caller.image,PIN)?;
        let program=nessie_windows_common::update_admission::known_folder(
            &windows_sys::Win32::UI::Shell::FOLDERID_ProgramFiles)?;
        let mut release=nessie_windows_common::release::load_at(
            &program.join("Nessie Executor/nessie-executor-native.exe"),PIN)?;
        release.verify_launch_consumers(PIN)?;release
    }else{nessie_windows_common::release::load_at(&caller.image, PIN)?};
    let store = Store::new(root);
    let mut state = store.read()?;
    reconcile(&mut state)?;
    let require_revoked = matches!(&operation, Operation::Clear { .. });
    let response = match operation {
        Operation::ExecutionCreator {request}=>{
            if !matches!(&request,nessie_windows_common::execution_creator::Request::Clear{..}){
                machine.admit_daemon(&release.digest)?;
            }
            crate::execution_creator::handle(root,&caller,&release,&mut state,request)?
        }
        Operation::ExecutionResource { request } => {
            machine.admit_daemon(&release.digest)?;
            crate::execution_resource::handle(root,&caller,&release,&state,*request)?
        }
        Operation::Execution { request } => {
            machine.admit_daemon(&release.digest)?;
            crate::execution::handle(root, &caller, &release, &state, request)?
        }
        Operation::Status => {
            process::interactive(&caller)?;
            serde_json::json!({"status":"verified","protocolVersion":1,"guardVersion":VERSION,
                "epochs":state.fences.iter().filter(|(_,fence)|fence.owner_sid==caller.sid).map(|(epoch,fence)|
                    serde_json::json!({"epoch":epoch,"revoked":fence.revoked})).collect::<Vec<_>>()})
        }
        Operation::HostCheck => {
            if !state.fences.is_empty() {
                return Err(REJECTED.into());
            }
            let parent = process::snapshot()?
                .into_iter()
                .find(|entry| entry.pid == pid)
                .ok_or(REJECTED)?
                .parent;
            let root = state
                .runtimes
                .values()
                .find(|record| {
                    record.child.pid == parent
                        && record.owner_sid == caller.sid
                        && record.release_digest == release.digest
                })
                .ok_or(REJECTED)?;
            let observed = Process::open(parent)?;
            if observed.generation != root.child || !observed.alive() {
                return Err(REJECTED.into());
            }
            serde_json::json!({"status":"verified","protocolVersion":1,"guardVersion":VERSION,"allowed":true})
        }
        Operation::Register {
            child_pid,
            job_name,
            release_digest,
            kind,
        } => {
            machine.admit(&release.digest)?;
            if matches!(kind, RuntimeKind::ServiceDaemon | RuntimeKind::UserDaemon | RuntimeKind::Credential | RuntimeKind::T3SessionGraph) {
                machine.admit_daemon(&release.digest)?;
            }
            let machine = matches!(
                kind,
                RuntimeKind::MachineAttestation
                    | RuntimeKind::ServiceDaemon
                    | RuntimeKind::ServiceControl
            );
            if machine
                && (caller.session != 0
                    || (caller.sid != "S-1-5-18"
                        && caller.sid
                            != nessie_windows_common::service_channel::service_account_sid()?))
            {
                return Err(REJECTED.into());
            }
            if matches!(
                kind,
                RuntimeKind::ServiceDaemon | RuntimeKind::ServiceControl
            ) && caller.sid != nessie_windows_common::service_channel::service_account_sid()?
            {
                return Err(REJECTED.into());
            }
            if release.digest != release_digest
                || (!machine
                    && ((caller.elevated && !state.fences.is_empty())
                        || state.fences.values().any(|fence| fence.revoked)
                        || state
                            .fences
                            .values()
                            .any(|fence| fence.owner_sid != caller.sid)))
            {
                return Err(REJECTED.into());
            }
            let child = Process::open(child_pid)?;
            let execution_graph=kind==RuntimeKind::T3SessionGraph;
            if execution_graph {
                if caller.sid!="S-1-5-18"||caller.session!=0||!state.fences.is_empty()
                    ||!owner_registered(root,&child.sid){return Err(REJECTED.into());}
                nessie_windows_common::process::interactive(&child)?;
                nessie_windows_common::execution_isolation::verify(&child)?;
            }
            let parent = process::snapshot()?
                .into_iter()
                .find(|entry| entry.pid == child_pid)
                .ok_or(REJECTED)?
                .parent;
            if parent != pid
                || (!execution_graph&&(child.sid != caller.sid||child.session != caller.session))
                || child.image != release.runtime.node_executable
                || job_members(&job_name)? != vec![child_pid]
            {
                return Err(REJECTED.into());
            }
            let name: Vec<u16> = std::ffi::OsStr::new(&job_name)
                .encode_wide()
                .chain(Some(0))
                .collect();
            let job = Owned(unsafe { OpenJobObjectW(JOB_OBJECT_QUERY, 0, name.as_ptr()) });
            let mut contained = 0;
            if job.0.is_null()
                || unsafe { IsProcessInJob(child.handle.0, job.0, &mut contained) } == 0
                || contained == 0
            {
                return Err(REJECTED.into());
            }
            let record = Record {
                protocol_version: 1,
                guard_version: VERSION,
                supervisor: caller.generation.clone(),
                child: child.generation,
                owner_sid: child.sid,
                session_id: child.session,
                release_digest,
                job_name,
                kind,
            };
            let key = format!("{}-{}", pid, caller.generation.started_at);
            if state.runtimes.contains_key(&key) {
                return Err(REJECTED.into());
            }
            state.runtimes.insert(key, record.clone());
            serde_json::json!({"registered":true,"record":record})
        }
        Operation::Inventory { nonce } => {
            process::interactive(&caller)?;
            if !owner_registered(root, &caller.sid) {
                return Err(REJECTED.into());
            }
            let records = inventory(&state, &caller, &release.digest)?;
            let epoch = state.begin_inventory(&caller.sid, caller.generation.clone(), &nonce)?;
            serde_json::json!({"status":"verified","protocolVersion":1,"nonce":nonce,"guardVersion":VERSION,
                "releaseDigest":release.digest,"machineEpoch":epoch,"records":records.iter().map(|record|serde_json::json!({
                    "protocolVersion":1,"guardVersion":VERSION,"bootId":record.child.boot_id,
                    "supervisorPid":record.supervisor.pid,"supervisorStartedAt":record.supervisor.started_at,
                    "childPid":record.child.pid,"childStartedAt":record.child.started_at,
                    "releaseDigest":record.release_digest})).collect::<Vec<_>>()})
        }
        Operation::Release { nonce } => {
            let hold = state.holds.get(&nonce).ok_or(REJECTED)?;
            if *hold != caller.generation {
                return Err(REJECTED.into());
            }
            // It remains a durable protection fence until a separately verified
            // clear. The probe finishing cannot prove credential deletion.
            state.holds.remove(&nonce);
            serde_json::json!({"released":true,"nonce":nonce})
        }
        Operation::Revoke { epoch } => {
            process::interactive(&caller)?;
            let fence = state.fences.get_mut(&epoch).ok_or(REJECTED)?;
            if fence.owner_sid != caller.sid {
                return Err(REJECTED.into());
            }
            fence.revoked = true;
            serde_json::json!({"revoked":true,"epoch":epoch})
        }
        Operation::Clear { epoch } | Operation::Recover { epoch } => {
            // The signed helper independently proves owner-file deletion before
            // this operation. Existing complete jobs still block actual clearance.
            process::interactive(&caller)?;
            let fence = state.fences.get(&epoch).ok_or(REJECTED)?;
            if fence.owner_sid != caller.sid || (require_revoked && !fence.revoked) {
                return Err(REJECTED.into());
            }
            live::credential_clearance(&state, &caller, &release.digest)?;
            state.fences.remove(&epoch);
            serde_json::json!({"cleared":true,"epoch":epoch})
        }
        Operation::HostAcquire { nonce } => {
            machine.admit_daemon(&release.digest)?;
            if !state.fences.is_empty() || state.hosts.contains_key(&nonce) {
                return Err(REJECTED.into());
            }
            let parent = process::snapshot()?
                .into_iter()
                .find(|entry| entry.pid == pid)
                .ok_or(REJECTED)?
                .parent;
            let runtime = state
                .runtimes
                .values()
                .find(|record| record.child.pid == parent && record.owner_sid == caller.sid
                    && record.release_digest==release.digest)
                .ok_or(REJECTED)?;
            let current=Process::open(parent)?;
            if current.generation!=runtime.child || !current.alive() {return Err(REJECTED.into());}
            state.hosts.insert(
                nonce.clone(),
                Host {
                    owner_sid: caller.sid.clone(),
                    controller: caller.generation.clone(),
                    runtime_child: runtime.child.clone(),
                    job_name: runtime.job_name.clone(),
                },
            );
            serde_json::json!({"acquired":true,"nonce":nonce})
        }
        Operation::HostRelease { nonce } => {
            let host = state.hosts.get(&nonce).ok_or(REJECTED)?;
            if host.controller != caller.generation || host.owner_sid != caller.sid {
                return Err(REJECTED.into());
            }
            if !host_members_cleared(&state, host, Some(caller.generation.pid))? {
                return Err(REJECTED.into());
            }
            state.hosts.remove(&nonce);
            serde_json::json!({"released":true,"nonce":nonce})
        }
    };
    if !caller.alive() {
        return Err(REJECTED.into());
    }
    store.write(&state)?;
    Ok(response)
}
#[cfg(test)]
#[path = "custody_tests.rs"]
mod tests;
