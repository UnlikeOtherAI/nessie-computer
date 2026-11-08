//! First observation is terminal even if no backend admission is ever issued.
use crate::{execution_context, execution_key::Key, execution_resource};
use nessie_windows_common::{
    custody::REJECTED,
    custody_store::State,
    execution::{now_ms, value_digest},
    execution_creator::CompanionRole,
    execution_secret_read::{self, Observe},
    process::Process,
    release::Release,
};
use serde_json::{json, Value};
use std::{path::Path, time::Instant};

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
pub fn observe(
    root: &Path,
    caller: &Process,
    release: &Release,
    state: &State,
    request: Observe,
) -> Result<Value, String> {
    let issued = now_ms()?;
    let started = Instant::now();
    request.validate()?;
    execution_context::require_companion_role(
        caller,
        release,
        state,
        CompanionRole::ExecutionSecretObserve,
    )?;
    let context = execution_context::authenticate_graph(
        root,
        caller,
        release,
        state,
        &request.binding.executor_id,
    )?;
    let key = Key::open(root, &request.binding.executor_id, false)?;
    let (graph, stored) = crate::execution::source_graph(&key, &request.binding)?;
    let resource_id = stored["resourceId"].as_str().ok_or(REJECTED)?;
    if graph.nonce != request.accepted_graph_nonce
        || resource_id != request.candidate.evidence.resource_id
        || stored["custody"] != serde_json::to_value(&context.custody).map_err(|_| REJECTED)?
    {
        return Err(REJECTED.into());
    }
    let observed = execution_resource::observe_secret_slot(
        resource_id,
        caller,
        &context,
        &graph,
        &request.candidate,
        request.environment_index,
    )?;
    let plan_digest =
        value_digest(&serde_json::to_value(&observed.candidate).map_err(|_| REJECTED)?)?;
    let claim =
        execution_secret_read::slot_claim(&request.binding, &graph.nonce, observed.slot.index)?;
    let plan_id = fresh_id()?;
    let read_id = fresh_id()?;
    let remaining = observed
        .source_deadline
        .saturating_duration_since(started)
        .as_millis()
        .min(5000) as u64;
    let expires = issued.checked_add(remaining).ok_or(REJECTED)?;
    // create_new + sync_all occurs before any tool eligibility check or proof.
    // Failure/crash leaves this graph/index unavailable; it cannot renew a read.
    key.claim(
        "secret-slot-observed",
        &claim,
        &json!({"version":1,"binding":request.binding,
        "acceptedGraphNonce":graph.nonce,"planId":plan_id,"readId":read_id,"planDigest":plan_digest,
        "evidence":observed.candidate.evidence,"slot":observed.slot,"account":observed.account,
        "recipient":{"slotId":request.recipient_slot_id,"generation":context.custody.runtime},
        "issuedAtMs":issued,"expiresAtMs":expires,"eligibility":"noninteractive-unqualified"}),
    )?;
    // This is negative metadata, never a PREPARATION receipt. No op-read creator
    // is enabled until the installed version's no-prompt contract is proven.
    Ok(
        json!({"status":"unavailable","reason":"T3_SECRET_READ_NONINTERACTIVE_UNQUALIFIED",
        "attemptId":read_id}),
    )
}
