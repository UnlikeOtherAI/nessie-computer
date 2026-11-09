//! Enrolled one-use admission for the entire original shutdown preparation.
use super::{proof, DescriptorContext, Held};
use crate::{
    execution_admission,
    execution_key::{canonical, sha, Key},
};
use nessie_windows_common::{
    custody::REJECTED,
    execution::{now_ms, Graph, SignedAdmission},
    execution_json,
    execution_resource::SETTINGS_LIMIT,
    execution_shutdown_admission::{self as protocol, Preparation},
    process::Process,
};
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{Duration, Instant},
};
pub(super) struct Pending {
    prepared: Preparation,
    deadline: Instant,
}
fn current(
    held: &Held,
    caller: &Process,
    context: &DescriptorContext,
    graph: &Graph,
) -> Result<(), String> {
    held.check_owner(caller, context)?;
    held.check_binding(caller, context, &graph.binding)?;
    let digest = nessie_windows_common::execution::value_digest(
        &serde_json::to_value(graph).map_err(|_| REJECTED)?,
    )?;
    if held.inspections.get(&graph.nonce) != Some(&digest) {
        return Err(REJECTED.into());
    }
    Ok(())
}
fn observe(
    held: &Held,
    graph: &Graph,
    selection_at_ms: u64,
    deadline: Instant,
) -> Result<nessie_windows_common::execution_shutdown::Observation, String> {
    let mut bytes = held.object("settings")?.bytes(SETTINGS_LIMIT)?;
    let result = held
        .destination
        .as_ref()
        .ok_or_else(|| REJECTED.to_string())
        .and_then(|destination| {
            destination.observe_shutdown(
                &graph.binding.source_generation,
                &bytes,
                selection_at_ms,
                deadline,
            )
        });
    bytes.fill(0);
    result
}
pub(super) fn prepare(
    root: &Path,
    held: &mut Held,
    caller: &Process,
    context: &DescriptorContext,
    graph: &Graph,
    selection_at_ms: u64,
) -> Result<Value, String> {
    let start = Instant::now();
    let observed_at_ms = now_ms()?;
    current(held, caller, context, graph)?;
    if observed_at_ms < selection_at_ms || observed_at_ms >= selection_at_ms.saturating_add(5000) {
        return Err(REJECTED.into());
    }
    let key = Key::open(root, &graph.binding.executor_id, false)?;
    let binding = proof::binding(held, graph, context, &key)?;
    proof::paired(root, caller, context, &binding)?;
    let slot = protocol::slot_id(&binding, &graph.nonce)?;
    if held.shutdowns.len() >= 256 {
        return Err(REJECTED.into());
    }
    key.claim(
        "shutdown-observed",
        &slot,
        &json!({"observedAtMs":observed_at_ms,"selectionAtMs":selection_at_ms}),
    )?;
    let expires_at_ms = selection_at_ms.saturating_add(5000).min(
        now_ms()?.saturating_add(
            held.deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as u64,
        ),
    );
    let deadline = (start + Duration::from_millis(expires_at_ms.saturating_sub(observed_at_ms)))
        .min(held.deadline);
    let mut observation = observe(held, graph, selection_at_ms, deadline)?;
    observation.observed_at_ms = observed_at_ms;
    let prepared = Preparation {
        version: 1,
        action: "prepare-shutdown".into(),
        binding,
        accepted_graph_nonce: graph.nonce.clone(),
        slot_id: slot.clone(),
        evidence: proof::evidence(held, graph, context)?,
        observation,
        nonce: slot.clone(),
        issued_at_ms: observed_at_ms,
        expires_at_ms,
        issuer_key_id: None,
        preparation_receipt_digest: None,
    };
    prepared.validate(now_ms()?, false)?;
    let value = serde_json::to_value(&prepared).map_err(|_| REJECTED)?;
    if canonical(&value)?.len() > 32768 || Instant::now() >= deadline {
        return Err(REJECTED.into());
    }
    key.claim("shutdown-prepared", &slot, &value)?;
    current(held, caller, context, graph)?;
    proof::paired(root, caller, context, &prepared.binding)?;
    prepared.validate(now_ms()?, false)?;
    if Instant::now() >= deadline {
        return Err(REJECTED.into());
    }
    let receipt = key.sign(protocol::PREPARATION_DOMAIN, &value)?;
    current(held, caller, context, graph)?;
    proof::paired(root, caller, context, &prepared.binding)?;
    prepared.validate(now_ms()?, false)?;
    if Instant::now() >= deadline {
        return Err(REJECTED.into());
    }
    held.shutdowns.insert(slot, Pending { prepared, deadline });
    Ok(json!({"receipt":receipt}))
}
pub(super) fn consume(
    root: &Path,
    held: &mut Held,
    caller: &Process,
    context: &DescriptorContext,
    graph: &Graph,
    signed: SignedAdmission,
) -> Result<Value, String> {
    let start = Instant::now();
    let now = now_ms()?;
    current(held, caller, context, graph)?;
    let key = Key::open(root, &graph.binding.executor_id, false)?;
    let binding = proof::binding(held, graph, context, &key)?;
    let slot = protocol::slot_id(&binding, &graph.nonce)?;
    let pending = held.shutdowns.remove(&slot).ok_or(REJECTED)?;
    let admitted: Preparation =
        serde_json::from_value(execution_json::parse(signed.payload.as_bytes())?)
            .map_err(|_| REJECTED)?;
    admitted.validate(now, true)?;
    let prepared = pending.prepared;
    let persisted: Preparation =
        serde_json::from_value(key.read("shutdown-prepared", &slot)?).map_err(|_| REJECTED)?;
    let digest =
        sha(canonical(&serde_json::to_value(&prepared).map_err(|_| REJECTED)?)?.as_bytes());
    let deadline = pending
        .deadline
        .min(start + Duration::from_millis(admitted.expires_at_ms.saturating_sub(now)));
    if admitted.binding != binding
        || admitted.slot_id != slot
        || persisted != prepared
        || Instant::now() >= deadline
        || !admitted.matches(&prepared, &key.key_id, &digest)
    {
        return Err(REJECTED.into());
    }
    execution_admission::verify_signature(
        root,
        &caller.sid,
        &signed,
        protocol::DOMAIN,
        &binding.executor_id,
        &binding.connection_epoch,
    )?;
    let mut fresh = observe(held, graph, prepared.observation.selection_at_ms, deadline)?;
    fresh.observed_at_ms = prepared.observation.observed_at_ms;
    if fresh != prepared.observation
        || proof::evidence(held, graph, context)? != prepared.evidence
        || Instant::now() >= deadline
    {
        return Err(REJECTED.into());
    }
    current(held, caller, context, graph)?;
    proof::paired(root, caller, context, &binding)?;
    admitted.validate(now_ms()?, true)?;
    key.claim(
        "shutdown-consumed",
        &slot,
        &json!({"admissionDigest":sha(signed.payload.as_bytes())}),
    )?;
    key.claim("nonce", &admitted.nonce, &json!({"shutdownSlot":slot}))?;
    current(held, caller, context, graph)?;
    proof::paired(root, caller, context, &binding)?;
    admitted.validate(now_ms()?, true)?;
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .as_millis() as u64;
    if remaining == 0 {
        return Err(REJECTED.into());
    }
    Ok(
        json!({"slotId":slot,"authorityDigest":prepared.observation.authority_digest,
        "notAfterMs":admitted.expires_at_ms,"remainingMs":remaining.min(5000)}),
    )
}
