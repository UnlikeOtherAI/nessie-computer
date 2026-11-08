//! Only the pinned SYSTEM creator reaches these transitions. Kernel observation
//! and durable creation claims precede resume; exit is not clearance.
use nessie_windows_common::{
    custody::{Record, RuntimeKind, REJECTED, VERSION},
    custody_observation::{absent, job_members},
    custody_store::State,
    execution::now_ms,
    execution_creator::{Creation, Request},
    execution_isolation,
    process::{self, Process},
    release::Release,
};
use serde_json::{json, Value};
use std::path::Path;

fn nonce(root: &Path, value: &str) -> Result<(), String> {
    use std::{fs::OpenOptions, io::Write};
    let _root = nessie_windows_common::release::pin_service_private(root, true)?;
    let path = root.join("execution-creation-nonces");
    std::fs::create_dir_all(&path).map_err(|_| REJECTED)?;
    let _directory = nessie_windows_common::release::pin_service_private(&path, true)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path.join(value))
        .map_err(|_| REJECTED)?;
    file.write_all(b"claimed\n")
        .and_then(|()| file.sync_all())
        .map_err(|_| REJECTED)?;
    Ok(())
}
fn current<'a>(
    state: &'a State,
    caller: &Process,
    release: &Release,
    id: &str,
) -> Result<&'a Creation, String> {
    let value = state.execution_creations.get(id).ok_or(REJECTED)?;
    if (value.creator != caller.generation
        && value.session_host.as_ref() != Some(&caller.generation))
        || value.release_digest != release.digest
        || value.cleared
    {
        return Err(REJECTED.into());
    }
    Ok(value)
}
fn graph(state: &State, pid: u32) -> Result<&Record, String> {
    state
        .runtimes
        .values()
        .find(|r| r.child.pid == pid && r.kind == RuntimeKind::T3SessionGraph)
        .ok_or(REJECTED.into())
}
pub fn handle(
    root: &Path,
    caller: &Process,
    release: &Release,
    state: &mut State,
    request: Request,
) -> Result<Value, String> {
    if caller.sid != "S-1-5-18"
        || (!matches!(
            &request,
            Request::Clear { .. } | Request::ClearSessionHost { .. }
        ) && !state.fences.is_empty())
    {
        return Err(REJECTED.into());
    }
    request.validate()?;
    if caller.session != 0
        && !state.execution_creations.values().any(|v| {
            v.session_host.as_ref() == Some(&caller.generation)
                && v.release_digest == release.digest
        })
    {
        return Err(REJECTED.into());
    }
    match request {
        Request::RegisterSessionHost { .. }
        | Request::SessionContext { .. }
        | Request::ClearSessionHost { .. } => {
            super::execution_session_host::handle(caller, release, state, request)
        }
        Request::AuthorizeGraph {
            executor_id,
            requester_pid,
            nonce: id,
        } => {
            if caller.session != 0 {
                return Err(REJECTED.into());
            }
            let requester = Process::open(requester_pid)?;
            let (owner, session, directory) = super::execution_creator_owner::resolve(
                root,
                release,
                state,
                &requester,
                &executor_id,
            )?;
            nonce(root, &id)?;
            if state.execution_creations.len() >= 256 || state.runtimes.len() >= 256 {
                return Err(REJECTED.into());
            }
            state.execution_creations.insert(
                id.clone(),
                Creation {
                    executor_id: executor_id.clone(),
                    creator: caller.generation.clone(),
                    session_host: None,
                    host_job_name: None,
                    requester: requester.generation,
                    graph: None,
                    role: None,
                    owner_sid: owner.clone(),
                    session_id: session,
                    state_directory: directory.clone(),
                    release_digest: release.digest.clone(),
                    child: None,
                    job_name: Some(format!(r"Global\NessieCustody-{id}")),
                    expires_at_ms: now_ms()?.checked_add(5000).ok_or(REJECTED)?,
                    cleared: false,
                    cleared_at_ms: None,
                },
            );
            Ok(
                json!({"ownerSid":owner,"sessionId":session,"stateDirectory":directory,"releaseDigest":release.digest}),
            )
        }
        Request::AuthorizeCompanion {
            graph_pid,
            role,
            nonce: id,
        } => {
            let graph = graph(state, graph_pid)?.clone();
            let actual = Process::open(graph_pid)?;
            if actual.generation != graph.child
                || !actual.alive()
                || graph.release_digest != release.digest
            {
                return Err(REJECTED.into());
            }
            execution_isolation::verify(&actual)?;
            let owner = state
                .execution_creations
                .values()
                .find(|v| v.child.as_ref() == Some(&graph.child) && v.role.is_none() && !v.cleared)
                .ok_or(REJECTED)?
                .clone();
            if owner.session_host.as_ref() != Some(&caller.generation) {
                return Err(REJECTED.into());
            }
            nonce(root, &id)?;
            if state.execution_creations.len() >= 256 {
                return Err(REJECTED.into());
            }
            state.execution_creations.insert(
                id.clone(),
                Creation {
                    executor_id: owner.executor_id,
                    creator: caller.generation.clone(),
                    session_host: None,
                    host_job_name: None,
                    requester: graph.child.clone(),
                    graph: Some(graph.child),
                    role: Some(role),
                    owner_sid: owner.owner_sid.clone(),
                    session_id: owner.session_id,
                    state_directory: owner.state_directory,
                    release_digest: release.digest.clone(),
                    child: None,
                    job_name: Some(format!(r"Global\NessieCustody-{id}")),
                    expires_at_ms: now_ms()?.checked_add(5000).ok_or(REJECTED)?,
                    cleared: false,
                    cleared_at_ms: None,
                },
            );
            Ok(
                json!({"ownerSid":owner.owner_sid,"sessionId":owner.session_id,"releaseDigest":release.digest}),
            )
        }
        Request::RegisterGraph {
            nonce: id,
            child_pid,
            job_name,
        } => {
            let creation = current(state, caller, release, &id)?.clone();
            if creation.role.is_some() {
                return Err(REJECTED.into());
            }
            let child = register(
                root, state, caller, release, &creation, child_pid, &job_name,
            )?;
            let record = Record {
                protocol_version: 1,
                guard_version: VERSION,
                supervisor: caller.generation.clone(),
                child: child.generation.clone(),
                owner_sid: child.sid.clone(),
                session_id: child.session,
                release_digest: release.digest.clone(),
                job_name: job_name.clone(),
                kind: RuntimeKind::T3SessionGraph,
            };
            state
                .runtimes
                .insert(format!("execution-{id}"), record.clone());
            let entry = state.execution_creations.get_mut(&id).ok_or(REJECTED)?;
            entry.child = Some(child.generation.clone());
            entry.job_name = Some(job_name);
            let context = crate::execution_context::authenticate_runtime(
                root,
                &child,
                release,
                state,
                &creation.executor_id,
            )?;
            Ok(json!({"registered":true,"record":record,"custody":context.custody}))
        }
        Request::RegisterCompanion {
            nonce: id,
            child_pid,
            job_name,
        } => {
            let creation = current(state, caller, release, &id)?.clone();
            if creation.role.is_none() {
                return Err(REJECTED.into());
            }
            let child = register(
                root, state, caller, release, &creation, child_pid, &job_name,
            )?;
            let entry = state.execution_creations.get_mut(&id).ok_or(REJECTED)?;
            entry.child = Some(child.generation.clone());
            entry.job_name = Some(job_name);
            Ok(json!({"registered":true,"child":child.generation}))
        }
        Request::Clear { nonce: id } => {
            let creation = state.execution_creations.get(&id).ok_or(REJECTED)?;
            if (creation.creator != caller.generation
                && creation.session_host.as_ref() != Some(&caller.generation))
                || creation.release_digest != release.digest
            {
                return Err(REJECTED.into());
            }
            let child = creation.child.as_ref().ok_or(REJECTED)?;
            if !absent(child)?
                || !job_members(creation.job_name.as_deref().ok_or(REJECTED)?)?.is_empty()
            {
                return Err(REJECTED.into());
            }
            if creation.role.is_none()
                && state
                    .execution_creations
                    .values()
                    .any(|v| v.graph.as_ref() == Some(child) && !v.cleared)
            {
                return Err(REJECTED.into());
            }
            let record = state.execution_creations.get_mut(&id).ok_or(REJECTED)?;
            record.cleared = true;
            record.cleared_at_ms.get_or_insert(now_ms()?);
            Ok(json!({"cleared":true}))
        }
    }
}
fn register(
    root: &Path,
    state: &State,
    caller: &Process,
    release: &Release,
    creation: &Creation,
    pid: u32,
    job: &str,
) -> Result<Process, String> {
    if creation.child.is_some()
        || creation.expires_at_ms <= now_ms()?
        || creation.job_name.as_deref() != Some(job)
    {
        return Err(REJECTED.into());
    }
    let requester = Process::open(creation.requester.pid)?;
    if requester.generation != creation.requester || !requester.alive() {
        return Err(REJECTED.into());
    }
    let child = Process::open(pid)?;
    let expected = if creation.role.is_none() {
        &release.runtime.node_executable
    } else {
        &release.runtime.native_helper
    };
    let parent = process::snapshot()?
        .into_iter()
        .find(|p| p.pid == pid)
        .ok_or(REJECTED)?
        .parent;
    if !child.alive()
        || child.sid != creation.owner_sid
        || child.session != creation.session_id
        || child.image != *expected
        || parent
            != creation
                .graph
                .as_ref()
                .map_or(caller.generation.pid, |g| g.pid)
        || job_members(job)? != vec![pid]
    {
        return Err(REJECTED.into());
    }
    execution_isolation::verify(&child)?;
    super::execution_admission::paired(root, &creation.executor_id, &child.sid)?;
    if let Some(g) = &creation.graph {
        let record = graph(state, g.pid)?;
        if record.child != *g || !job_members(&record.job_name)?.contains(&pid) {
            return Err(REJECTED.into());
        }
    }
    Ok(child)
}
