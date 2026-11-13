//! Enrolled observation and independently verified one-use SQL-preclaim consume.
//! The service never mutates the original SQLite row or grants effect execution.
use super::{
    commands,
    proof::{binding, evidence, paired},
    DescriptorContext, Held,
};
use crate::{
    execution_admission,
    execution_key::{canonical, sha, Key},
};
use nessie_windows_common::{
    custody::REJECTED,
    execution::{now_ms, Graph, SignedAdmission},
    execution_json,
    execution_preclaim::{self as protocol, Preclaim},
    process::Process,
};
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{Duration, Instant},
};
pub(super) struct Pending {
    prepared: Preclaim,
    deadline: Instant,
}
pub(super) fn prepare(
    root: &Path,
    held: &mut Held,
    caller: &Process,
    context: &DescriptorContext,
    graph: &Graph,
    effect: &str,
) -> Result<Value, String> {
    let started = Instant::now();
    let key = Key::open(root, &graph.binding.executor_id, false)?;
    let binding = binding(held, graph, context, &key)?;
    paired(root, caller, context, &binding)?;
    let bound = commands::bound(held, caller, context, graph, effect)?.ok_or(REJECTED)?;
    let id = protocol::claim_id(
        &binding,
        &graph.nonce,
        effect,
        bound.observation.attempt_count,
    )?;
    if held.preclaims.len() >= 256 || held.preclaims.contains_key(&id) {
        return Err(REJECTED.into());
    }
    let now = now_ms()?;
    let cap = held
        .command_lineages
        .get(&binding.command_id)
        .ok_or(REJECTED)?
        .expires_at_ms;
    let expires = bound
        .observation
        .observed_at_ms
        .saturating_add(5000)
        .min(cap)
        .min(
            now.saturating_add(
                held.deadline
                    .saturating_duration_since(Instant::now())
                    .as_millis() as u64,
            ),
        );
    let prepared = Preclaim {
        version: 1,
        action: "claim-original-provider-turn-start".into(),
        binding,
        accepted_graph_nonce: graph.nonce.clone(),
        claim_id: id.clone(),
        evidence: evidence(held, graph, context)?,
        nonce: id.clone(),
        issued_at_ms: bound.observation.observed_at_ms,
        expires_at_ms: expires,
        bound,
        issuer_key_id: None,
        preparation_receipt_digest: None,
    };
    prepared.validate(now_ms()?, false)?;
    let deadline = (started + Duration::from_millis(5000))
        .min(Instant::now() + Duration::from_millis(expires.saturating_sub(now_ms()?)));
    // Stable graph/effect/attempt identity survives changed row/nonce/read IDs.
    // A failed or uncertain publication remains burned; no fresh observation retry.
    key.claim(
        "preclaim-observed",
        &id,
        &serde_json::to_value(&prepared).map_err(|_| REJECTED)?,
    )?;
    held.recheck()?;
    paired(root, caller, context, &prepared.binding)?;
    if Instant::now() >= deadline {
        return Err(REJECTED.into());
    }
    prepared.validate(now_ms()?, false)?;
    let receipt = key.sign(
        protocol::PREPARATION_DOMAIN,
        &serde_json::to_value(&prepared).map_err(|_| REJECTED)?,
    )?;
    held.preclaims.insert(id, Pending { prepared, deadline });
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
    let admission_start = Instant::now();
    let admission_now = now_ms()?;
    let admitted: Preclaim =
        serde_json::from_value(execution_json::parse(signed.payload.as_bytes())?)
            .map_err(|_| REJECTED)?;
    // This is the sole consume attempt, including failed/uncertain verification
    // and observed expiry. Clock rollback cannot revive that held preparation.
    // Its durable first-observation record already prevents a new preparation.
    let pending = held.preclaims.remove(&admitted.claim_id).ok_or(REJECTED)?;
    admitted.validate(admission_now, true)?;
    let key = Key::open(root, &graph.binding.executor_id, false)?;
    if admitted.binding != binding(held, graph, context, &key)?
        || admitted.accepted_graph_nonce != graph.nonce
    {
        return Err(REJECTED.into());
    }
    let prepared = pending.prepared;
    // The backend may shorten the observed cap. Preserve that shorter budget
    // monotonically across signature/network waits and wall-clock rollback.
    let deadline = pending.deadline.min(
        admission_start
            + Duration::from_millis(admitted.expires_at_ms.saturating_sub(admission_now)),
    );
    let persisted: Preclaim =
        serde_json::from_value(key.read("preclaim-observed", &admitted.claim_id)?)
            .map_err(|_| REJECTED)?;
    let digest =
        sha(canonical(&serde_json::to_value(&prepared).map_err(|_| REJECTED)?)?.as_bytes());
    if Instant::now() >= deadline
        || persisted != prepared
        || !admitted.matches(&prepared, &key.key_id, &digest)
    {
        return Err(REJECTED.into());
    }
    execution_admission::verify_signature(
        root,
        &caller.sid,
        &signed,
        protocol::DOMAIN,
        &admitted.binding.executor_id,
        &admitted.binding.connection_epoch,
    )?;
    let mut fresh = commands::bound(
        held,
        caller,
        context,
        graph,
        &prepared.bound.observation.effect_id,
    )?
    .ok_or(REJECTED)?;
    fresh.observation.observed_at_ms = prepared.bound.observation.observed_at_ms;
    if fresh != prepared.bound
        || evidence(held, graph, context)? != prepared.evidence
        || Instant::now() >= deadline
    {
        return Err(REJECTED.into());
    }
    admitted.validate(now_ms()?, true)?;
    paired(root, caller, context, &admitted.binding)?;
    key.claim(
        "preclaim-consumed",
        &admitted.claim_id,
        &json!({"admissionDigest":sha(signed.payload.as_bytes())}),
    )?;
    key.claim(
        "nonce",
        &admitted.nonce,
        &json!({"preclaimId":admitted.claim_id}),
    )?;
    held.recheck()?;
    paired(root, caller, context, &admitted.binding)?;
    admitted.validate(now_ms()?, true)?;
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .as_millis() as u64;
    if remaining == 0 {
        return Err(REJECTED.into());
    }
    Ok(
        json!({"claimId":admitted.claim_id,"effectId":admitted.bound.observation.effect_id,
        "rowDigest":admitted.bound.observation.row_digest,"notAfterMs":admitted.expires_at_ms,"remainingMs":remaining.min(5000)}),
    )
}
