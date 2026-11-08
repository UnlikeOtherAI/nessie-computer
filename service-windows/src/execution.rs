//! Protected execution transitions. No receipt is signed from an unadmitted alias/selection DTO.
use crate::{
    execution_admission, execution_context,
    execution_key::{canonical, sha, Key},
};
use nessie_windows_common::{
    custody::REJECTED,
    custody_store::State,
    execution::*,
    process::{self, Process},
    release::Release,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, sync::Mutex};
static REVIEWS: Mutex<
    BTreeMap<
        String,
        (
            Challenge,
            Descriptor,
            nessie_windows_common::custody::Generation,
        ),
    >,
> = Mutex::new(BTreeMap::new());

fn value<T: serde::Serialize>(v: &T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|_| REJECTED.into())
}
fn challenge_matches(challenge: &Challenge, descriptor: &Descriptor) -> Result<(), String> {
    challenge.validate(now_ms()?)?;
    if challenge.executor_id != descriptor.executor_id
        || challenge.paired_origin != descriptor.paired_origin
        || challenge.descriptor_digest != sha(canonical(&value(descriptor)?)?.as_bytes())
    {
        return Err(REJECTED.into());
    }
    Ok(())
}
fn bound(
    root: &Path,
    caller: &Process,
    release: &Release,
    state: &State,
    signed: &SignedAdmission,
    phase: &str,
) -> Result<(Admission, Descriptor, Key), String> {
    let admission = execution_admission::verify(root, &caller.sid, signed)?;
    let (descriptor, key) = execution_context::descriptor(
        root,
        caller,
        release,
        state,
        &admission.binding.executor_id,
        false,
    )?;
    if admission.phase != phase
        || admission.issuer_key_id != key.key_id
        || admission.release_digest != release.digest
    {
        return Err(REJECTED.into());
    }
    recheck_source(root, caller, release, state, &key, &admission.binding)?;
    key.claim(
        "nonce",
        &admission.nonce,
        &json!({"admissionDigest":sha(signed.payload.as_bytes())}),
    )?;
    Ok((admission, descriptor, key))
}
fn recheck_source(
    root: &Path,
    caller: &Process,
    release: &Release,
    state: &State,
    key: &Key,
    binding: &Binding,
) -> Result<(), String> {
    let evidence = binding.source_evidence_digest.as_deref().ok_or(REJECTED)?;
    let record = key.read("graph", evidence.strip_prefix("sha256:").ok_or(REJECTED)?)?;
    let graph: Graph = serde_json::from_value(record["graph"].clone()).map_err(|_| REJECTED)?;
    let mut original = binding.clone();
    original.source_evidence_digest = None;
    if graph.binding != original {
        return Err(REJECTED.into());
    }
    let context =
        execution_context::authenticate_graph(root, caller, release, state, &binding.executor_id)?;
    if record["custody"] != value(&context.custody)? {
        return Err(REJECTED.into());
    }
    crate::execution_resource::bind_graph(
        record["resourceId"].as_str().ok_or(REJECTED)?,
        caller,
        &context,
        &graph,
    )
}
fn reservation(key: &Key, id: &str, descriptor: &Descriptor) -> Result<Value, String> {
    let original = key.read("reserve", id)?;
    if original["custody"] != value(&descriptor.custody)? {
        return Err(REJECTED.into());
    }
    Ok(original)
}
pub fn handle(
    root: &Path,
    caller: &Process,
    release: &Release,
    state: &State,
    request: Request,
) -> Result<Value, String> {
    request.validate()?;
    use nessie_windows_common::execution_creator::CompanionRole as Role;
    let role = match &request {
        Request::Offer { .. } => Role::ExecutionOffer,
        Request::Review { .. } | Request::Approve { .. } => Role::ExecutionEnroll,
        Request::Graph { .. } => Role::ExecutionGraph,
        Request::Reserve { .. } => Role::ExecutionReserve,
        Request::Prepare { .. } => Role::ExecutionPrepare,
        Request::Associate { .. } => Role::ExecutionAssociate,
        // Provider creation is a distinct SYSTEM transition. No fixed companion
        // role authorizes the old same-user launcher or observation route.
        Request::Launch { .. } | Request::Observe { .. } => return Err(REJECTED.into()),
    };
    execution_context::require_companion_role(caller, release, state, role)?;
    match request {
        Request::Offer { executor_id } => {
            let (descriptor, _) =
                execution_context::descriptor(root, caller, release, state, &executor_id, true)?;
            value(&descriptor)
        }
        Request::Graph {
            inspection,
            resource_id,
            graph,
        } => {
            // Only the fixed registered graph runtime can reach this through its native child.
            // Backend compares the persisted inspection challenge and every original target.
            let (descriptor, key) = execution_context::descriptor(
                root,
                caller,
                release,
                state,
                &graph.binding.executor_id,
                false,
            )?;
            let inspection = execution_admission::inspection(root, &caller.sid, &inspection)?;
            if inspection.issuer_key_id != key.key_id {
                return Err(REJECTED.into());
            }
            inspection.matches_graph(&graph)?;
            let context = execution_context::authenticate_graph(
                root,
                caller,
                release,
                state,
                &graph.binding.executor_id,
            )?;
            crate::execution_resource::bind_graph(&resource_id, caller, &context, &graph)?;
            graph.validate()?;
            let mut payload = value(&graph)?;
            payload["custody"] = value(&descriptor.custody)?;
            key.claim("nonce", &graph.nonce, &payload)?;
            let receipt = key.sign(GRAPH_DOMAIN, &payload)?;
            let evidence = sha(receipt["payload"].as_str().ok_or(REJECTED)?.as_bytes());
            key.claim(
                "graph",
                evidence.strip_prefix("sha256:").ok_or(REJECTED)?,
                &json!({"graph":graph,"resourceId":resource_id,"custody":descriptor.custody}),
            )?;
            Ok(receipt)
        }
        Request::Review { challenge } => {
            process::interactive(caller)?;
            let (descriptor, _) = execution_context::descriptor(
                root,
                caller,
                release,
                state,
                &challenge.executor_id,
                false,
            )?;
            challenge_matches(&challenge, &descriptor)?;
            let mut reviews = REVIEWS.lock().map_err(|_| REJECTED)?;
            let now = now_ms()?;
            reviews.retain(|_, (c, _, _)| c.expires_at_ms > now);
            if reviews.len() >= 64 || reviews.contains_key(&challenge.enrollment_id) {
                return Err(REJECTED.into());
            }
            reviews.insert(
                challenge.enrollment_id.clone(),
                (challenge, descriptor.clone(), caller.generation.clone()),
            );
            value(&descriptor)
        }
        Request::Approve { challenge } => {
            process::interactive(caller)?;
            let (descriptor, key) = execution_context::descriptor(
                root,
                caller,
                release,
                state,
                &challenge.executor_id,
                false,
            )?;
            challenge_matches(&challenge, &descriptor)?;
            let reviewed = REVIEWS
                .lock()
                .map_err(|_| REJECTED)?
                .remove(&challenge.enrollment_id)
                .ok_or(REJECTED)?;
            if reviewed
                != (
                    challenge.clone(),
                    descriptor.clone(),
                    caller.generation.clone(),
                )
            {
                return Err(REJECTED.into());
            }
            // Only the signed native enrollment command reaches this after its protected owner dialog.
            // No external generic native-command entry exposes Approve.
            let proof = json!({"version":1,"challenge":challenge,"descriptor":descriptor,
                "approvedAtMs":now_ms()?,"localApproval":"protected-owner-dialog"});
            key.claim("enroll", &challenge.enrollment_id, &proof)?;
            key.sign(ISSUER_DOMAIN, &proof)
        }
        Request::Reserve { admission: signed } => {
            let (admission, descriptor, key) =
                bound(root, caller, release, state, &signed, "reserve")?;
            let payload = json!({"version":1,"reservationId":admission.reservation_id,
                "admissionDigest":sha(signed.payload.as_bytes()),"binding":admission.binding,
                "custody":descriptor.custody,"nonce":admission.nonce,
                "issuedAtMs":now_ms()?,"expiresAtMs":admission.expires_at_ms});
            key.claim("reserve", &admission.reservation_id, &payload)?;
            key.sign(RESERVATION_DOMAIN, &payload)
        }
        Request::Prepare {
            executor_id,
            reservation_id,
            provider_session_id,
            launch,
        } => {
            let (descriptor, key) =
                execution_context::descriptor(root, caller, release, state, &executor_id, false)?;
            let mut payload = reservation(&key, &reservation_id, &descriptor)?;
            let binding: Binding =
                serde_json::from_value(payload["binding"].clone()).map_err(|_| REJECTED)?;
            recheck_source(root, caller, release, state, &key, &binding)?;
            // Reserve TTL bounds acceptance only. This receipt grants no execution;
            // the backend rechecks current parent authority before fresh launch admission.
            launch.validate()?;
            let held = crate::execution_preparation::hold(&reservation_id, &descriptor, launch)?;
            // Scoped environment remains in held service memory, never the replay journal.
            payload["launchDigest"] = held["launchDigest"].clone();
            payload["providerSessionId"] = json!(provider_session_id);
            let issued=now_ms()?;
            payload["issuedAtMs"] = json!(issued);
            payload["expiresAtMs"] = json!(issued.checked_add(5000).ok_or(REJECTED)?);
            key.claim(
                "prepare",
                &reservation_id,
                &json!({"receipt":payload,"command":held["command"],
                "providerImageDigest":held["providerImageDigest"]}),
            )?;
            key.sign(PREPARATION_DOMAIN, &payload)
        }
        Request::Launch { admission: signed } => {
            let (admission, descriptor, key) =
                bound(root, caller, release, state, &signed, "launch")?;
            let reserved = reservation(&key, &admission.reservation_id, &descriptor)?;
            let prepared = key.read("prepare", &admission.reservation_id)?;
            if reserved["binding"] != value(&admission.binding)?
                || prepared["receipt"]["launchDigest"] != value(&admission.launch_digest)?
            {
                return Err(REJECTED.into());
            }
            admission.validate(now_ms()?)?;
            crate::execution_preparation::recheck(
                &admission.reservation_id,
                &descriptor,
                admission.launch_digest.as_deref().ok_or(REJECTED)?,
            )?;
            key.claim(
                "launch",
                &admission.reservation_id,
                &json!({"admission":admission,
                "controller":caller.generation,"prepared":prepared}),
            )?;
            Ok(
                json!({"permitted":true,"reservationId":admission.reservation_id,
                    "service":descriptor.custody.service,"expiresAtMs":admission.expires_at_ms}),
            )
        }
        Request::Associate { admission: signed } => {
            let (admission, descriptor, key) =
                bound(root, caller, release, state, &signed, "associate")?;
            let mut payload = reservation(&key, &admission.reservation_id, &descriptor)?;
            if payload["binding"] != value(&admission.binding)? {
                return Err(REJECTED.into());
            }
            let observed = crate::execution_observation::consume(
                &admission.reservation_id,
                &admission,
                &descriptor,
            )?;
            payload["admissionDigest"] = json!(sha(signed.payload.as_bytes()));
            payload["launchDigest"] = value(&admission.launch_digest)?;
            payload["providerSessionId"] = value(&admission.provider_session_id)?;
            payload["nativeId"] = observed["nativeId"].clone();
            payload["provider"] = observed["provider"].clone();
            payload["providerImageDigest"] = observed["providerImageDigest"].clone();
            payload["observation"] = observed["observation"].clone();
            payload["nonce"] = json!(admission.nonce);
            payload["issuedAtMs"] = json!(now_ms()?);
            payload["expiresAtMs"] = json!(admission.expires_at_ms);
            key.claim("associate", &admission.reservation_id, &payload)?;
            key.sign(ASSOCIATION_DOMAIN, &payload)
        }
        Request::Observe {
            executor_id,
            reservation_id,
            child_pid,
            stdout_handle,
            output_handle,
            provider_session_id,
        } => {
            let (descriptor, key) =
                execution_context::descriptor(root, caller, release, state, &executor_id, false)?;
            crate::execution_observation::attach(
                caller,
                &descriptor,
                &key,
                &reservation_id,
                child_pid,
                stdout_handle,
                output_handle,
                provider_session_id,
            )?;
            Ok(json!({"observing":true}))
        }
    }
}
pub fn image_digest(mut file: std::fs::File) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut hash = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|_| REJECTED)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
