//! Independent native verification of a fresh already-issued backend effect.
//! The graph carries no machine state, issuer URL or caller-supplied public key.
use crate::{
    execution_admission,
    execution_key::{canonical, Key},
};
use nessie_windows_common::{
    custody::REJECTED,
    execution::{now_ms, SignedAdmission},
    execution_effect::{Proof, DOMAIN},
    execution_frame::Context,
    execution_process::Record,
    process::Process,
};
use std::path::Path;
pub fn verify(
    root: &Path,
    key: &Key,
    record: &Record,
    context: &Context,
    proof: &Proof,
) -> Result<u64, String> {
    let grant = &proof.grant;
    grant.validate(now_ms()?)?;
    let binding = &record.admission.binding;
    let association = key.read("associate", &record.admission.reservation_id)?;
    if grant.executor_id != binding.executor_id
        || grant.environment_id != binding.environment_id
        || grant.thread_id != binding.thread_id
        || grant.connection_epoch != binding.connection_epoch
        || grant.runtime_generation != binding.runtime_generation
        || grant.provider_session_id != record.provider_session_id
        || context.provider_session_id != record.provider_session_id
        || grant.correlation_id != context.correlation_id
        || grant.command_id != context.command_id
        || grant.request_digest != context.request_digest
        || grant.native_association.driver != binding.driver
        || grant.native_association.continuation_home_key != binding.continuation_home_key
        || grant.native_association.history_home_key != binding.history_home_key
        || association["nativeId"] != grant.native_association.native_id
        || association["providerSessionId"] != record.provider_session_id
        || association["provider"] != serde_json::to_value(&record.child).map_err(|_| REJECTED)?
        || association["custody"]
            != serde_json::to_value(&record.descriptor.custody).map_err(|_| REJECTED)?
    {
        return Err(REJECTED.into());
    }
    let graph = Process::open(record.graph.pid)?;
    if graph.generation != record.graph {
        return Err(REJECTED.into());
    }
    let signed = SignedAdmission {
        payload: canonical(&serde_json::to_value(grant).map_err(|_| REJECTED)?)?,
        key_id: proof.key_id.clone(),
        signature: proof.signature.clone(),
    };
    execution_admission::verify_signature(
        root,
        &graph.sid,
        &signed,
        DOMAIN,
        &binding.executor_id,
        &binding.connection_epoch,
    )?;
    grant.validate(now_ms()?)
}
