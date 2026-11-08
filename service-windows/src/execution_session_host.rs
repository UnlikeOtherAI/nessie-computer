//! The updater alone enrolls a suspended SYSTEM host in the paired user's
//! Windows session. This does not admit an original operation or provider.
use nessie_windows_common::{
    custody::REJECTED,
    custody_observation::{absent, job_members},
    custody_store::State,
    execution::now_ms,
    execution_creator::Request,
    process::{self, Process},
    release::Release,
};
use serde_json::{json, Value};
pub fn handle(
    caller: &Process,
    release: &Release,
    state: &mut State,
    request: Request,
) -> Result<Value, String> {
    match request {
        Request::RegisterSessionHost {
            nonce,
            child_pid,
            job_name,
        } => {
            let value = state.execution_creations.get_mut(&nonce).ok_or(REJECTED)?;
            if caller.session != 0
                || value.creator != caller.generation
                || value.session_host.is_some()
                || value.child.is_some()
                || value.cleared
                || value.expires_at_ms <= now_ms()?
                || value.release_digest != release.digest
            {
                return Err(REJECTED.into());
            }
            let child = Process::open(child_pid)?;
            let parent = process::snapshot()?
                .into_iter()
                .find(|p| p.pid == child_pid)
                .ok_or(REJECTED)?
                .parent;
            if child.sid != "S-1-5-18"
                || child.session != value.session_id
                || !child.alive()
                || child.image != release.runtime.native_helper
                || parent != caller.generation.pid
                || job_name != format!(r"Global\NessieCustodyHost-{nonce}")
                || job_members(&job_name)? != vec![child_pid]
            {
                return Err(REJECTED.into());
            }
            nessie_windows_common::execution_isolation::verify(&child)?;
            value.session_host = Some(child.generation);
            value.host_job_name = Some(job_name);
            Ok(json!({"registered":true}))
        }
        Request::SessionContext { nonce } => {
            let value = state.execution_creations.get(&nonce).ok_or(REJECTED)?;
            if value.session_host.as_ref() != Some(&caller.generation)
                || value.cleared
                || value.expires_at_ms <= now_ms()?
                || value.release_digest != release.digest
            {
                return Err(REJECTED.into());
            }
            let parent = Process::open(value.creator.pid)?;
            if parent.generation != value.creator || !parent.alive() {
                return Err(REJECTED.into());
            }
            Ok(
                json!({"executorId":value.executor_id,"ownerSid":value.owner_sid,
                "sessionId":value.session_id,"stateDirectory":value.state_directory}),
            )
        }
        Request::ClearSessionHost { nonce } => {
            let value = state.execution_creations.get(&nonce).ok_or(REJECTED)?;
            if caller.session != 0
                || value.creator != caller.generation
                || value.release_digest != release.digest
                || !value.cleared
                || !absent(value.session_host.as_ref().ok_or(REJECTED)?)?
                || !job_members(value.host_job_name.as_deref().ok_or(REJECTED)?)?.is_empty()
            {
                return Err(REJECTED.into());
            }
            Ok(json!({"cleared":true}))
        }
        _ => Err(REJECTED.into()),
    }
}
