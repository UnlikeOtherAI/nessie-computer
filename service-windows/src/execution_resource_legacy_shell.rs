//! Independently observed, enrolled, one-use permission for the complete original
//! conditional shell writer only. No provider, lease, command or file permission.
use super::{proof, DescriptorContext, Held};
use crate::{
    execution_admission,
    execution_key::{canonical, sha, Key},
};
use nessie_windows_common::{
    custody::REJECTED,
    execution::{now_ms, Graph, SignedAdmission},
    execution_json,
    execution_legacy_shell_admission::{self as protocol, Preparation},
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
pub(super) fn prepare(
    root: &Path,
    held: &mut Held,
    caller: &Process,
    context: &DescriptorContext,
    graph: &Graph,
    not_after_ms: u64,
) -> Result<Value, String> {
    let start = Instant::now();
    let observed_at_ms = now_ms()?;
    current(held, caller, context, graph)?;
    let key = Key::open(root, &graph.binding.executor_id, false)?;
    let binding = proof::binding(held, graph, context, &key)?;
    proof::paired(root, caller, context, &binding)?;
    let slot = protocol::slot_id(&binding, &graph.nonce)?;
    if held.legacy_shells.len() >= 256 {
        return Err(REJECTED.into());
    }
    // Burn the logical graph/action before reading. Failed/expired observation
    // or lost publication cannot obtain a fresh five-second window.
    key.claim(
        "legacy-shell-observed",
        &slot,
        &json!({"observedAtMs":observed_at_ms}),
    )?;
    let mut observation = held
        .destination
        .as_ref()
        .ok_or(REJECTED)?
        .observe_legacy_shells(&binding.source_generation)?;
    observation.observed_at_ms = observed_at_ms;
    let remaining_resource = held
        .deadline
        .saturating_duration_since(Instant::now())
        .as_millis() as u64;
    // The original candidate may predate this native observation. This input
    // can only shorten the service's own cap; it supplies no authority.
    let expires_at_ms = observed_at_ms
        .saturating_add(5000)
        .min(not_after_ms)
        .min(now_ms()?.saturating_add(remaining_resource));
    let prepared = Preparation {
        version: 1,
        action: "legacy-shell-reconcile".into(),
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
    let deadline = (start + Duration::from_millis(5000))
        .min(Instant::now() + Duration::from_millis(expires_at_ms.saturating_sub(now_ms()?)));
    prepared.validate(now_ms()?, false)?;
    let value = serde_json::to_value(&prepared).map_err(|_| REJECTED)?;
    if canonical(&value)?.len() > 32768 || Instant::now() >= deadline {
        return Err(REJECTED.into());
    }
    key.claim("legacy-shell-prepared", &slot, &value)?;
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
    held.legacy_shells
        .insert(slot, Pending { prepared, deadline });
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
    // Select the held graph/action before parsing any caller payload. Every
    // actual consume attempt burns it, including a malformed signed payload.
    let pending = held.legacy_shells.remove(&slot).ok_or(REJECTED)?;
    let admitted: Preparation =
        serde_json::from_value(execution_json::parse(signed.payload.as_bytes())?)
            .map_err(|_| REJECTED)?;
    admitted.validate(now, true)?;
    let prepared = pending.prepared;
    let persisted: Preparation =
        serde_json::from_value(key.read("legacy-shell-prepared", &slot)?).map_err(|_| REJECTED)?;
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
    let mut fresh = held
        .destination
        .as_ref()
        .ok_or(REJECTED)?
        .observe_legacy_shells(&binding.source_generation)?;
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
        "legacy-shell-consumed",
        &slot,
        &json!({"admissionDigest":sha(signed.payload.as_bytes())}),
    )?;
    key.claim("nonce", &admitted.nonce, &json!({"legacyShellSlot":slot}))?;
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
        json!({"slotId":slot,"planDigest":prepared.observation.plan_digest,
        "notAfterMs":admitted.expires_at_ms,"remainingMs":remaining.min(5000)}),
    )
}
