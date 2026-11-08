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
    let runtime = state
        .runtimes
        .values()
        .find(|r| {
            r.child.pid == parent
                && r.owner_sid == caller.sid
                && r.release_digest == release.digest
                && r.kind == RuntimeKind::T3SessionGraph
        })
        .ok_or(REJECTED)?;
    let actual = Process::open(parent)?;
    let supervisor = Process::open(runtime.supervisor.pid)?;
    // Signed images and a Job are not process isolation. Only the fixed SYSTEM
    // creator may attest startup before the user graph's first instruction.
    // The current same-user managed-runtime starter intentionally cannot pass.
    if supervisor.sid != "S-1-5-18" || supervisor.session != 0 {
        return Err(REJECTED.into());
    }
    nessie_windows_common::execution_isolation::verify(&actual)?;
    nessie_windows_common::execution_isolation::verify(caller)?;
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
    let mut installed = nessie_windows_common::release::load_at(&caller.image, PIN)?;
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
    let (origin, _) = paired(root, executor, &caller.sid)?;
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
