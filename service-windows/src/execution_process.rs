//! Only the enrolled SYSTEM session host can create a provider/history child.
//! The launch descriptor comes from a live service hold, never this request.
use crate::{
    execution_admission, execution_context,
    execution_key::{sha, Key},
    execution_preparation,
};
use nessie_windows_common::{
    custody::REJECTED,
    custody_observation::{absent, job_members},
    custody_store::State,
    execution::{now_ms, ProcessPurpose},
    execution_process::{Record, Request},
    process::{self, Process},
    release::Release,
};
use serde_json::{json, Value};
use std::path::Path;
pub(crate) fn graph(
    root: &Path,
    caller: &Process,
    release: &Release,
    state: &State,
    pid: u32,
    executor: &str,
) -> Result<Process, String> {
    if caller.sid != "S-1-5-18" || caller.session == 0 || !state.fences.is_empty() {
        return Err(REJECTED.into());
    }
    let actual = Process::open(pid)?;
    if !state.execution_creations.values().any(|v| {
        v.child.as_ref() == Some(&actual.generation)
            && v.session_host.as_ref() == Some(&caller.generation)
            && !v.cleared
            && v.executor_id == executor
            && v.release_digest == release.digest
    }) {
        return Err(REJECTED.into());
    }
    execution_context::authenticate_runtime(root, &actual, release, state, executor)?;
    Ok(actual)
}
pub fn handle(
    root: &Path,
    caller: &Process,
    release: &Release,
    state: &mut State,
    request: Request,
) -> Result<Value, String> {
    request.validate()?;
    match request {
        Request::Authorize {
            graph_pid,
            nonce,
            admission: signed,
        } => {
            let selected: nessie_windows_common::execution::Admission =
                serde_json::from_str(&signed.payload).map_err(|_| REJECTED)?;
            let actual = graph(
                root,
                caller,
                release,
                state,
                graph_pid,
                &selected.binding.executor_id,
            )?;
            let admission = execution_admission::verify(root, &actual.sid, &signed)?;
            let (descriptor, key) = execution_context::runtime_descriptor(
                root,
                &actual,
                release,
                state,
                &admission.binding.executor_id,
            )?;
            if admission.phase != "launch"
                || admission.issuer_key_id != key.key_id
                || admission.release_digest != release.digest
            {
                return Err(REJECTED.into());
            }
            let context = execution_context::authenticate_runtime(
                root,
                &actual,
                release,
                state,
                &admission.binding.executor_id,
            )?;
            crate::execution::recheck_held_source(&actual, &context, &key, &admission.binding)?;
            let reserve = key.read("reserve", &admission.reservation_id)?;
            let prepared = key.read("prepare", &admission.reservation_id)?;
            if reserve["binding"]
                != serde_json::to_value(&admission.binding).map_err(|_| REJECTED)?
                || reserve["custody"]
                    != serde_json::to_value(&descriptor.custody).map_err(|_| REJECTED)?
                || prepared["receipt"]["launchDigest"]
                    != serde_json::to_value(&admission.launch_digest).map_err(|_| REJECTED)?
                || prepared["receipt"]["processPurpose"]
                    != serde_json::to_value(&admission.process_purpose).map_err(|_| REJECTED)?
            {
                return Err(REJECTED.into());
            }
            let launch = execution_preparation::selected(
                &admission.reservation_id,
                &descriptor,
                admission.launch_digest.as_deref().ok_or(REJECTED)?,
            )?;
            if Some(&launch.process_purpose) != admission.process_purpose.as_ref() {
                return Err(REJECTED.into());
            }
            let provider_session_id = prepared["receipt"]["providerSessionId"]
                .as_str()
                .ok_or(REJECTED)?
                .to_owned();
            if state.execution_processes.len() >= 256
                || state.execution_processes.contains_key(&nonce)
            {
                return Err(REJECTED.into());
            }
            admission.validate(now_ms()?)?;
            key.claim(
                "nonce",
                &admission.nonce,
                &json!({"admissionDigest":sha(signed.payload.as_bytes())}),
            )?;
            key.claim(
                "launch",
                &admission.reservation_id,
                &json!({"admission":admission,"controller":actual.generation,
                "prepared":prepared,"creationId":nonce}),
            )?;
            key.claim(
                "process-creation",
                &nonce,
                &json!({"reservationId":admission.reservation_id}),
            )?;
            let record = Record {
                creator: caller.generation.clone(),
                graph: actual.generation,
                nonce: nonce.clone(),
                job_name: format!(r"Global\NessieCustody-{nonce}"),
                descriptor,
                admission,
                admission_digest: sha(signed.payload.as_bytes()),
                provider_session_id,
                command: launch.command.clone(),
                image_digest: prepared["providerImageDigest"]
                    .as_str()
                    .ok_or(REJECTED)?
                    .into(),
                history_payload_digest: launch
                    .history
                    .as_ref()
                    .map(|value| {
                        nessie_windows_common::execution::value_digest(
                            &serde_json::to_value(value).map_err(|_| REJECTED)?,
                        )
                    })
                    .transpose()?,
                child: None,
                resumed: false,
                cleared: false,
            };
            state.execution_processes.insert(nonce, record.clone());
            Ok(
                json!({"record":record,"launch":launch,"ownerSid":actual.sid,"sessionId":actual.session}),
            )
        }
        Request::Register {
            nonce,
            child_pid,
            thread_handle,
            stdin_handle,
            stdout_handle,
            output_handle,
        } => {
            let record = state
                .execution_processes
                .get(&nonce)
                .ok_or(REJECTED)?
                .clone();
            if record.creator != caller.generation || record.child.is_some() || record.cleared {
                return Err(REJECTED.into());
            }
            let actual = graph(
                root,
                caller,
                release,
                state,
                record.graph.pid,
                &record.admission.binding.executor_id,
            )?;
            record.admission.validate(now_ms()?)?;
            let child = Process::open(child_pid)?;
            let parent = process::snapshot()?
                .into_iter()
                .find(|p| p.pid == child_pid)
                .ok_or(REJECTED)?
                .parent;
            if parent != actual.generation.pid
                || child.sid != actual.sid
                || child.session != actual.session
                || child.image != Path::new(&record.command)
                || !child.alive()
                || job_members(&record.job_name)? != vec![child_pid]
                || !job_members(&record.descriptor.custody.job_name)?.contains(&child_pid)
            {
                return Err(REJECTED.into());
            }
            nessie_windows_common::execution_isolation::verify(&child)?;
            if crate::execution::image_digest(nessie_windows_common::release::pin_execution_image(
                &child.image,
            )?)? != record.image_digest
            {
                return Err(REJECTED.into());
            }
            recheck(root, caller, release, state, &record)?;
            crate::execution_process_io::attach(
                caller,
                &record,
                &child,
                thread_handle,
                stdin_handle,
                stdout_handle,
                output_handle,
            )?;
            state
                .execution_processes
                .get_mut(&nonce)
                .ok_or(REJECTED)?
                .child = Some(child.generation.clone());
            Ok(
                json!({"registered":true,"child":child.generation,"expiresAtMs":record.admission.expires_at_ms}),
            )
        }
        Request::Resume { nonce } => {
            let record = state
                .execution_processes
                .get(&nonce)
                .ok_or(REJECTED)?
                .clone();
            if record.resumed || record.cleared || record.child.is_none() {
                return Err(REJECTED.into());
            }
            recheck(root, caller, release, state, &record)?;
            let key = Key::open(root, &record.admission.binding.executor_id, false)?;
            key.claim(
                "process-resumed",
                &nonce,
                &json!({"admissionDigest":record.admission_digest,"child":record.child}),
            )?;
            record.admission.validate(now_ms()?)?;
            // The service owns this thread handle. A host never receives a reusable resume permit.
            crate::execution_process_io::resume(&nonce)?;
            state
                .execution_processes
                .get_mut(&nonce)
                .ok_or(REJECTED)?
                .resumed = true;
            Ok(json!({"resumed":true}))
        }
        Request::End { nonce } => {
            let record = state.execution_processes.get(&nonce).ok_or(REJECTED)?;
            if caller.generation != record.creator || record.cleared || !record.resumed {
                return Err(REJECTED.into());
            }
            crate::execution_process_io::end(&nonce)?;
            Ok(json!({"inputEnded":true}))
        }
        Request::Clear { nonce } => {
            let record = state
                .execution_processes
                .get(&nonce)
                .ok_or(REJECTED)?
                .clone();
            if caller.generation != record.creator
                || !absent(record.child.as_ref().ok_or(REJECTED)?)?
                || !job_members(&record.job_name)?.is_empty()
            {
                return Err(REJECTED.into());
            }
            let key = Key::open(root, &record.admission.binding.executor_id, false)?;
            if let Some(result) = key.cleared_process(&nonce)? {
                state
                    .execution_processes
                    .get_mut(&nonce)
                    .ok_or(REJECTED)?
                    .cleared = true;
                return Ok(result);
            }
            crate::execution_process_io::clear(&nonce)?;
            let result = if record.admission.process_purpose != Some(ProcessPurpose::Provider) {
                crate::execution_process_io::history_result(&record, &key)?
            } else {
                json!({"cleared":true})
            };
            key.claim("process-cleared", &nonce, &result)?;
            state
                .execution_processes
                .get_mut(&nonce)
                .ok_or(REJECTED)?
                .cleared = true;
            crate::execution_process_io::release(&nonce)?;
            Ok(result)
        }
    }
}
fn recheck(
    root: &Path,
    caller: &Process,
    release: &Release,
    state: &State,
    record: &Record,
) -> Result<(), String> {
    if record.creator != caller.generation || record.cleared {
        return Err(REJECTED.into());
    }
    let actual = graph(
        root,
        caller,
        release,
        state,
        record.graph.pid,
        &record.admission.binding.executor_id,
    )?;
    if actual.generation != record.graph {
        return Err(REJECTED.into());
    }
    let context = execution_context::authenticate_runtime(
        root,
        &actual,
        release,
        state,
        &record.admission.binding.executor_id,
    )?;
    let (descriptor, key) = execution_context::runtime_descriptor(
        root,
        &actual,
        release,
        state,
        &record.admission.binding.executor_id,
    )?;
    if descriptor != record.descriptor {
        return Err(REJECTED.into());
    }
    crate::execution::recheck_held_source(&actual, &context, &key, &record.admission.binding)?;
    execution_preparation::recheck(
        &record.admission.reservation_id,
        &descriptor,
        record.admission.launch_digest.as_deref().ok_or(REJECTED)?,
    )?;
    record.admission.validate(now_ms()?)
}
