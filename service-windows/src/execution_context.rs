//! Kernel and immutable installed-release facts, never caller-supplied custody.
use crate::{execution_admission::paired, execution_key::Key};
use nessie_windows_common::{
    custody::{RuntimeKind, REJECTED},
    custody_observation::job_members,
    custody_store::State,
    execution::{Custody, Descriptor},
    process::{self, Process},
    release::Release,
};
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path};
const PIN: Option<&str> = option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");
pub(crate) struct DescriptorContext {
    pub paired_origin: String,
    pub custody: Custody,
}
/// Role is observed from the SYSTEM creation journal, never supplied by the request.
pub(crate) fn require_companion_role(
    caller: &Process,
    release: &Release,
    state: &State,
    role: nessie_windows_common::execution_creator::CompanionRole,
) -> Result<(), String> {
    if !state.execution_creations.values().any(|record| {
        record.child.as_ref() == Some(&caller.generation)
            && !record.cleared
            && record.release_digest == release.digest
            && record.role.as_ref() == Some(&role)
    }) {
        return Err(REJECTED.into());
    }
    Ok(())
}
/// Service-only kernel peer gate. Resource receivers must call this before opening
/// or disclosing held execution settings. This does not grant a native effect.
pub(crate) fn authenticate_graph(
    root: &Path,
    caller: &Process,
    release: &Release,
    state: &State,
    executor: &str,
) -> Result<DescriptorContext, String> {
    if !state.fences.is_empty() {
        return Err(REJECTED.into());
    }
    let parent = process::snapshot()?
        .into_iter()
        .find(|p| p.pid == caller.generation.pid)
        .ok_or(REJECTED)?
        .parent;
    let actual = Process::open(parent)?;
    nessie_windows_common::execution_isolation::verify(caller)?;
    if !state.execution_creations.values().any(|record| {
        record.child.as_ref() == Some(&caller.generation)
            && record.graph.as_ref() == Some(&actual.generation)
            && record.role.is_some()
            && !record.cleared
            && record.executor_id == executor
            && record.release_digest == release.digest
    }) {
        return Err(REJECTED.into());
    }
    authenticate_runtime(root, &actual, release, state, executor)
}
pub(crate) fn authenticate_runtime(
    root: &Path,
    actual: &Process,
    release: &Release,
    state: &State,
    executor: &str,
) -> Result<DescriptorContext, String> {
    if !state.fences.is_empty() {
        return Err(REJECTED.into());
    }
    let parent = actual.generation.pid;
    let runtime = state
        .runtimes
        .values()
        .find(|r| {
            r.child.pid == parent
                && r.owner_sid == actual.sid
                && r.release_digest == release.digest
                && r.kind == RuntimeKind::T3SessionGraph
        })
        .ok_or(REJECTED)?;
    let supervisor = Process::open(runtime.supervisor.pid)?;
    // Signed images and a Job are not process isolation. Only the fixed SYSTEM
    // creator may attest startup before the user graph's first instruction.
    // The current same-user managed-runtime starter intentionally cannot pass.
    let creation = state
        .execution_creations
        .values()
        .find(|v| {
            v.child.as_ref() == Some(&runtime.child)
                && v.session_host.as_ref() == Some(&supervisor.generation)
                && !v.cleared
        })
        .ok_or(REJECTED)?;
    let updater = Process::open(creation.creator.pid)?;
    if supervisor.sid != "S-1-5-18"
        || supervisor.session != actual.session
        || supervisor.image != release.runtime.native_helper
        || updater.generation != creation.creator
        || updater.sid != "S-1-5-18"
        || updater.session != 0
        || !updater.alive()
    {
        return Err(REJECTED.into());
    }
    nessie_windows_common::execution_isolation::verify(actual)?;
    if !actual.alive()
        || actual.generation != runtime.child
        || actual.image != release.runtime.node_executable
        || !supervisor.alive()
        || supervisor.generation != runtime.supervisor
        || !job_members(&runtime.job_name)?.contains(&parent)
    {
        return Err(REJECTED.into());
    }
    let own = Process::open(std::process::id())?;
    own.signed(PIN)?;
    if own.image != release.runtime.root.join("nessie-executor-service.exe") {
        return Err(REJECTED.into());
    }
    let mut installed =
        nessie_windows_common::release::load_at(&release.runtime.native_helper, PIN)?;
    installed.verify_launch_consumers(PIN)?;
    let mut image = nessie_windows_common::release::pin_protected(&own.image, false)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = image.read(&mut buffer).map_err(|_| REJECTED)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let (origin, _) = paired(root, executor, &actual.sid)?;
    Ok(DescriptorContext {
        paired_origin: origin,
        custody: Custody {
            service: own.generation,
            // Stable actual managed graph controller, not the short-lived native request process.
            controller: runtime.child.clone(),
            supervisor: runtime.supervisor.clone(),
            runtime: runtime.child.clone(),
            job_name: runtime.job_name.clone(),
            release_digest: release.digest.clone(),
            service_image_digest: format!("{:x}", hasher.finalize()),
        },
    })
}
pub fn descriptor(
    root: &Path,
    caller: &Process,
    release: &Release,
    state: &State,
    executor: &str,
    create: bool,
) -> Result<(Descriptor, Key), String> {
    let context = authenticate_graph(root, caller, release, state, executor)?;
    let key = Key::open(root, executor, create)?;
    let descriptor = Descriptor {
        version: 1,
        executor_id: executor.into(),
        paired_origin: context.paired_origin,
        key_id: key.key_id.clone(),
        public_key: key.public_key.clone(),
        custody: context.custody,
    };
    Ok((descriptor, key))
}
