//! Exact bytes stay in service memory between original serialization and the
//! backend's finite FRAME decision. No reserialization or second write input.
use crate::{
    execution_admission,
    execution_key::{sha, Key},
    execution_process, execution_process_io,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use nessie_windows_common::{
    custody::REJECTED,
    custody_observation::job_members,
    custody_store::State,
    execution::{now_ms, ProcessPurpose},
    execution_frame::{self, Admission, Context, Frame, Request},
    execution_process::Record,
    process::Process,
    release::Release,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, sync::Mutex};
struct Held {
    id: String,
    context: Context,
    frame: Frame,
    total: usize,
    bytes: Vec<u8>,
    deadline: u64,
    receipt: Option<Value>,
    associated: bool,
}
static HELD: Mutex<BTreeMap<String, Held>> = Mutex::new(BTreeMap::new());
fn fresh_id() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    if unsafe {
        windows_sys::Win32::Security::Cryptography::BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            32,
            2,
        )
    } < 0
    {
        return Err(REJECTED.into());
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn current(
    root: &Path,
    caller: &Process,
    release: &Release,
    state: &State,
    nonce: &str,
) -> Result<(Record, Key), String> {
    let record = state
        .execution_processes
        .get(nonce)
        .ok_or(REJECTED)?
        .clone();
    if !record.resumed
        || record.cleared
        || record.admission.process_purpose != Some(ProcessPurpose::Provider)
    {
        return Err(REJECTED.into());
    }
    execution_process::recheck_live(root, caller, release, state, &record)?;
    let child = record.child.as_ref().ok_or(REJECTED)?;
    let actual = Process::open(child.pid)?;
    if actual.generation != *child
        || !actual.alive()
        || !job_members(&record.job_name)?.contains(&child.pid)
    {
        return Err(REJECTED.into());
    }
    nessie_windows_common::execution_isolation::verify(&actual)?;
    let observation = execution_process_io::get(nonce)?;
    if observation.lock().map_err(|_| REJECTED)?.failed {
        return Err(REJECTED.into());
    }
    let key = Key::open(root, &record.admission.binding.executor_id, false)?;
    if key.key_id != record.descriptor.key_id {
        return Err(REJECTED.into());
    }
    Ok((record, key))
}
pub fn handle(
    root: &Path,
    caller: &Process,
    release: &Release,
    state: &State,
    nonce: &str,
    request: Request,
) -> Result<Value, String> {
    request.validate()?;
    let (record, key) = current(root, caller, release, state, nonce)?;
    let associated = key.associated(&record.admission.reservation_id)?;
    match request {
        Request::Begin {
            context,
            frame,
            byte_length,
        } => {
            if (!associated
                && !context.matches(&record.admission.binding, &record.provider_session_id))
                || context.provider_session_id != record.provider_session_id
                || frame.driver != record.admission.binding.driver
                || frame.kind == "response"
            {
                return Err(REJECTED.into());
            }
            let mut held = HELD.lock().map_err(|_| REJECTED)?;
            if held.len() >= 256 || held.contains_key(nonce) {
                return Err(REJECTED.into());
            }
            let id = fresh_id()?;
            let deadline = now_ms()?.checked_add(5000).ok_or(REJECTED)?;
            held.insert(
                nonce.into(),
                Held {
                    id: id.clone(),
                    context,
                    frame,
                    total: byte_length as usize,
                    bytes: Vec::with_capacity(byte_length as usize),
                    deadline,
                    receipt: None,
                    associated,
                },
            );
            Ok(json!({"frameId":id}))
        }
        Request::Append {
            frame_id,
            offset,
            data,
        } => {
            let bytes = STANDARD.decode(&data).map_err(|_| REJECTED)?;
            if bytes.is_empty() || bytes.len() > 16384 || STANDARD.encode(&bytes) != data {
                return Err(REJECTED.into());
            }
            let mut all = HELD.lock().map_err(|_| REJECTED)?;
            let held = all.get_mut(nonce).ok_or(REJECTED)?;
            if held.id != frame_id
                || held.receipt.is_some()
                || held.deadline <= now_ms()?
                || offset as usize != held.bytes.len()
                || held.bytes.len() + bytes.len() > held.total
            {
                return Err(REJECTED.into());
            }
            held.bytes.extend(bytes);
            Ok(json!({"received":held.bytes.len()}))
        }
        Request::Prepare { frame_id } => {
            if associated {
                return Err(REJECTED.into());
            }
            let mut all = HELD.lock().map_err(|_| REJECTED)?;
            let held = all.get_mut(nonce).ok_or(REJECTED)?;
            if held.associated
                || held.id != frame_id
                || held.deadline <= now_ms()?
                || held.bytes.len() != held.total
                || !held
                    .context
                    .matches(&record.admission.binding, &record.provider_session_id)
            {
                return Err(REJECTED.into());
            }
            if let Some(receipt) = &held.receipt {
                return Ok(receipt.clone());
            }
            let (frame, _) = nessie_windows_common::execution_frame_bytes::decode(
                &held.frame.driver,
                &held.bytes,
            )?;
            if frame != held.frame {
                return Err(REJECTED.into());
            }
            let issued = now_ms()?;
            let payload = json!({"version":1,"reservationId":record.admission.reservation_id,"frameId":held.id,
                "binding":record.admission.binding,"providerSessionId":record.provider_session_id,
                "launchDigest":record.admission.launch_digest,"processPurpose":"provider","child":record.child,
                "frame":frame,"nonce":held.id,"issuedAtMs":issued,"expiresAtMs":held.deadline,
                "admissionDigest":record.admission_digest,"custody":record.descriptor.custody});
            if held.deadline <= issued {
                return Err(REJECTED.into());
            }
            let receipt = key.sign(execution_frame::PREPARATION_DOMAIN, &payload)?;
            held.receipt = Some(receipt.clone());
            Ok(receipt)
        }
        Request::Commit { admission: signed } => {
            if associated {
                return Err(REJECTED.into());
            }
            let admission: Admission = serde_json::from_value(
                nessie_windows_common::execution_json::parse(signed.payload.as_bytes())?,
            )
            .map_err(|_| REJECTED)?;
            admission.validate(now_ms()?)?;
            let graph = Process::open(record.graph.pid)?;
            execution_admission::verify_signature(
                root,
                &graph.sid,
                &signed,
                execution_frame::DOMAIN,
                &record.admission.binding.executor_id,
                &record.admission.binding.connection_epoch,
            )?;
            let (current, _) = current(root, caller, release, state, nonce)?;
            if current.child != record.child {
                return Err(REJECTED.into());
            }
            let mut all = HELD.lock().map_err(|_| REJECTED)?;
            let held = all.get(nonce).ok_or(REJECTED)?;
            let receipt = held.receipt.as_ref().ok_or(REJECTED)?;
            if held.associated
                || held.deadline <= now_ms()?
                || admission.binding != record.admission.binding
                || admission.frame_id != held.id
                || admission.frame != held.frame
                || admission.reservation_id != record.admission.reservation_id
                || Some(&admission.child) != record.child.as_ref()
                || admission.provider_session_id != record.provider_session_id
                || Some(&admission.launch_digest) != record.admission.launch_digest.as_ref()
                || admission.issuer_key_id != key.key_id
                || admission.release_digest != record.descriptor.custody.release_digest
                || admission.expires_at_ms > held.deadline
                || admission.frame_receipt_digest
                    != sha(receipt["payload"].as_str().ok_or(REJECTED)?.as_bytes())
            {
                return Err(REJECTED.into());
            }
            admission.validate(now_ms()?)?;
            key.claim(
                "nonce",
                &admission.nonce,
                &json!({"frameId":admission.frame_id}),
            )?;
            key.claim(
                "frame-consumed",
                &admission.frame_id,
                &json!({"admissionDigest":sha(signed.payload.as_bytes())}),
            )?;
            let held = all.remove(nonce).ok_or(REJECTED)?;
            drop(all);
            // Claimed and removed before the pipe effect; no lost ACK can be replayed.
            admission.validate(now_ms()?)?;
            execution_process_io::expect(nonce, &held.frame)?;
            execution_process_io::write(
                nonce,
                held.bytes,
                admission.expires_at_ms.min(held.deadline),
            )?;
            Ok(json!({"written":true,"frameId":admission.frame_id}))
        }
        Request::Stage { frame_id } => {
            let all = HELD.lock().map_err(|_| REJECTED)?;
            let held = all.get(nonce).ok_or(REJECTED)?;
            if !associated
                || !held.associated
                || held.id != frame_id
                || held.bytes.len() != held.total
                || held.deadline <= now_ms()?
            {
                return Err(REJECTED.into());
            }
            let (frame, _) = nessie_windows_common::execution_frame_bytes::decode(
                &held.frame.driver,
                &held.bytes,
            )?;
            if frame != held.frame {
                return Err(REJECTED.into());
            }
            Ok(json!({"frameId":frame_id}))
        }
        Request::CommitEffect { frame_id, proof } => {
            if !associated {
                return Err(REJECTED.into());
            }
            let context = {
                let all = HELD.lock().map_err(|_| REJECTED)?;
                let held = all.get(nonce).ok_or(REJECTED)?;
                if !held.associated
                    || held.id != frame_id
                    || held.deadline <= now_ms()?
                    || held.bytes.len() != held.total
                {
                    return Err(REJECTED.into());
                }
                let (frame, _) = nessie_windows_common::execution_frame_bytes::decode(
                    &held.frame.driver,
                    &held.bytes,
                )?;
                if frame != held.frame {
                    return Err(REJECTED.into());
                }
                held.context.clone()
            };
            crate::execution_effect::verify(root, &key, &record, &context, &proof)?;
            current(root, caller, release, state, nonce)?;
            let mut all = HELD.lock().map_err(|_| REJECTED)?;
            let held = all.get(nonce).ok_or(REJECTED)?;
            if held.id != frame_id || held.deadline <= now_ms()? {
                return Err(REJECTED.into());
            }
            let claim = sha(proof.grant.request_nonce.as_bytes());
            key.claim(
                "effect-consumed",
                claim.strip_prefix("sha256:").ok_or(REJECTED)?,
                &json!({"frameId":frame_id}),
            )?;
            key.claim(
                "frame-consumed",
                &frame_id,
                &json!({"effectNonceDigest":claim}),
            )?;
            let held = all.remove(nonce).ok_or(REJECTED)?;
            drop(all);
            let deadline = proof.grant.validate(now_ms()?)?;
            execution_process_io::expect(nonce, &held.frame)?;
            execution_process_io::write(nonce, held.bytes, deadline.min(held.deadline))?;
            Ok(json!({"written":true,"frameId":frame_id}))
        }
        Request::AutomaticReply { protocol_id } => {
            // Only a service-constructed refusal to a live observed request.
            execution_process_io::automatic_reply(nonce, &protocol_id)?;
            Ok(json!({"replied":true}))
        }
    }
}
pub fn release(nonce: &str) -> Result<(), String> {
    if let Some(mut held) = HELD.lock().map_err(|_| REJECTED)?.remove(nonce) {
        held.bytes.fill(0);
    }
    Ok(())
}
