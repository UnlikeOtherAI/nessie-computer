//! Source observation only. Never resolves a reference or opens a credential child.
use super::{resources, DescriptorContext};
use nessie_windows_common::{
    custody::REJECTED,
    execution::{value_digest, Graph},
    execution_resource::SETTINGS_LIMIT,
    execution_secret_plan::{self, Slot},
    execution_secret_read::{Candidate, Evidence},
    process::Process,
};
use std::time::Instant;

pub(crate) struct ObservedSlot {
    pub candidate: Candidate,
    pub slot: Slot,
    pub account: String,
    pub source_deadline: Instant,
}
pub(crate) fn observe_secret_slot(
    resource_id: &str,
    caller: &Process,
    context: &DescriptorContext,
    graph: &Graph,
    candidate: &Candidate,
    environment_index: u32,
) -> Result<ObservedSlot, String> {
    let mut resources = resources().lock().map_err(|_| REJECTED)?;
    let result = (|| {
        let held = resources.get(resource_id).ok_or(REJECTED)?;
        held.recheck()?;
        held.check_binding(caller, context, &graph.binding)?;
        let graph_digest = value_digest(&serde_json::to_value(graph).map_err(|_| REJECTED)?)?;
        if held.inspections.get(&graph.nonce) != Some(&graph_digest)
            || held.graph_generation.is_none()
        {
            return Err(REJECTED.into());
        }
        let mut bytes = held.object("settings")?.bytes(SETTINGS_LIMIT)?;
        let observed = execution_secret_plan::observe(
            &bytes,
            &graph.binding.provider_instance_id,
            &graph.binding.driver,
        );
        bytes.fill(0);
        let observed = observed?;
        let actual = Candidate {
            evidence: Evidence {
                resource_id: held.receipt.resource_id.clone(),
                resource_generation: held.receipt.resource_generation.clone(),
                settings_identity: held.receipt.evidence.settings_identity.clone(),
                settings_digest: held.receipt.evidence.settings_digest.clone(),
                provider_instance_id: graph.binding.provider_instance_id.clone(),
                provider_config_digest: observed.provider_config_digest,
                secret_providers_digest: observed.secret_providers_digest,
                credential_home_reference_id: graph.binding.credential_binding_id.clone(),
                custody: context.custody.clone(),
            },
            selection: observed.selection,
        };
        if actual != *candidate {
            return Err(REJECTED.into());
        }
        let position = actual
            .selection
            .environment
            .iter()
            .position(|s| s.index == environment_index)
            .ok_or(REJECTED)?;
        let slot = actual.selection.environment[position].clone();
        let account = observed.accounts.get(position).ok_or(REJECTED)?.clone();
        held.recheck()?;
        Ok(ObservedSlot {
            candidate: actual,
            slot,
            account,
            source_deadline: held.deadline,
        })
    })();
    if result.is_err() {
        resources.remove(resource_id);
    }
    result
}
