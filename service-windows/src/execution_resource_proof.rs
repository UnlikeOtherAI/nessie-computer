//! Current physical evidence for independently admitted finite SQL actions.
use super::{DescriptorContext, Held};
use crate::{
    execution_admission,
    execution_key::{canonical, sha, Key},
};
use nessie_windows_common::{
    custody::REJECTED,
    execution::{Binding, Graph},
    execution_resource::DestinationEvidence,
    process::Process,
};
use std::path::Path;

pub(super) fn binding(
    held: &Held,
    graph: &Graph,
    context: &DescriptorContext,
    key: &Key,
) -> Result<Binding, String> {
    let mut payload = serde_json::to_value(graph).map_err(|_| REJECTED)?;
    payload["custody"] = serde_json::to_value(&context.custody).map_err(|_| REJECTED)?;
    let mut binding = graph.binding.clone();
    binding.source_evidence_digest = Some(sha(canonical(&payload)?.as_bytes()));
    let (original, record) = crate::execution::source_graph(key, &binding)?;
    if serde_json::to_value(original).map_err(|_| REJECTED)?
        != serde_json::to_value(graph).map_err(|_| REJECTED)?
        || record["resourceId"] != held.receipt.resource_id
        || record["custody"] != payload["custody"]
    {
        return Err(REJECTED.into());
    }
    Ok(binding)
}
pub(super) fn evidence(
    held: &Held,
    graph: &Graph,
    context: &DescriptorContext,
) -> Result<DestinationEvidence, String> {
    Ok(DestinationEvidence {
        resource_id: held.receipt.resource_id.clone(),
        resource_generation: held.receipt.resource_generation.clone(),
        source_database_identity: held.receipt.evidence.source.database_identity.clone(),
        destination_database_identity: held
            .destination
            .as_ref()
            .ok_or(REJECTED)?
            .stage_identity(&graph.binding.source_generation)?,
        settings_identity: held.receipt.evidence.settings_identity.clone(),
        settings_digest: held.receipt.evidence.settings_digest.clone(),
        custody: context.custody.clone(),
    })
}
pub(super) fn paired(
    root: &Path,
    caller: &Process,
    context: &DescriptorContext,
    binding: &Binding,
) -> Result<(), String> {
    let pair = execution_admission::paired(root, &binding.executor_id, &caller.sid)?;
    if pair.0 != context.paired_origin || pair.1 != binding.connection_epoch {
        return Err(REJECTED.into());
    }
    Ok(())
}
