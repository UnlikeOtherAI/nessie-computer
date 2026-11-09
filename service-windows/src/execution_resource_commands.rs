//! Metadata from the protected original callback owner, with independent SQL
//! acceptance checks. No native signing or mutation permission is issued here.
use super::{DescriptorContext, Held};
use nessie_windows_common::{
    custody::REJECTED,
    execution::{now_ms, value_digest, Graph},
    execution_command_lineage::{Capture, Edge},
    process::Process,
};
use serde_json::{json, Value};

fn graph(held: &Held, caller: &Process, context: &DescriptorContext, graph: &Graph) -> Result<String, String> {
    held.check_owner(caller, context)?;
    held.check_binding(caller, context, &graph.binding)?;
    let digest = value_digest(&serde_json::to_value(graph).map_err(|_| REJECTED)?)?;
    if held.inspections.get(&graph.nonce) != Some(&digest) {
        return Err(REJECTED.into());
    }
    Ok(digest)
}
fn capture<'a>(held: &'a mut Held, digest: &str, graph: &Graph) -> Result<&'a mut Capture, String> {
    let capture = held
        .command_lineages
        .get_mut(&graph.binding.command_id)
        .ok_or(REJECTED)?;
    if capture.graph_digest != digest {
        capture.close();
        return Err(REJECTED.into());
    }
    capture.current(now_ms()?)?;
    Ok(capture)
}
pub(super) fn open(
    held: &mut Held,
    caller: &Process,
    context: &DescriptorContext,
    observed: &Graph,
    expires: u64,
) -> Result<Value, String> {
    let digest = graph(held, caller, context, observed)?;
    if expires <= now_ms()? {
        return Err(REJECTED.into());
    }
    let binding = &observed.binding;
    if held.command_lineages.contains_key(&binding.command_id) {
        let old = capture(held, &digest, observed)?;
        if old.expires_at_ms != expires {
            old.close();
            return Err(REJECTED.into());
        }
    } else {
        if held.command_lineages.len() >= 256 {
            return Err(REJECTED.into());
        }
        held.command_lineages.insert(
            binding.command_id.clone(),
            Capture::new(
                digest,
                binding.command_id.clone(),
                binding.thread_id.clone(),
                binding.provider_instance_id.clone(),
                expires,
                now_ms()?,
            ),
        );
    }
    held.recheck()?;
    Ok(json!({"opened":true}))
}
pub(super) fn close(
    held: &mut Held,
    caller: &Process,
    context: &DescriptorContext,
    observed: &Graph,
) -> Result<Value, String> {
    let digest = graph(held, caller, context, observed)?;
    let old = held
        .command_lineages
        .get_mut(&observed.binding.command_id)
        .ok_or(REJECTED)?;
    if old.graph_digest != digest {
        old.close();
        return Err(REJECTED.into());
    }
    old.close(); // Tombstone remains; another graph nonce/cap cannot reopen this parent.
    Ok(json!({"closed":true}))
}
pub(super) fn record(
    held: &mut Held,
    caller: &Process,
    context: &DescriptorContext,
    observed: &Graph,
    edge: Edge,
) -> Result<Value, String> {
    let digest = graph(held, caller, context, observed)?;
    let result = (|| {
        let old = capture(held, &digest, observed)?;
        let first = old.initial().cloned();
        let accepted = old.accepted().cloned();
        let destination = held.destination.as_ref().ok_or(REJECTED)?;
        let initial = if let Edge::InitialAccepted { run_id, .. } = &edge {
            Some(destination.accept_initial_command(observed, first.as_ref().ok_or(REJECTED)?, run_id)?)
        } else {
            None
        };
        let release = if let Edge::ReleaseAccepted { command_id, .. } = &edge {
            Some(destination.accept_release_command(
                observed,
                first.as_ref().ok_or(REJECTED)?,
                accepted.as_ref().ok_or(REJECTED)?,
                command_id,
            )?)
        } else {
            None
        };
        held.recheck()?;
        capture(held, &digest, observed)?.record(&edge, initial, release, now_ms()?)?;
        held.recheck()?;
        Ok(json!({"recorded":true}))
    })();
    if result.is_err() {
        if let Some(old) = held.command_lineages.get_mut(&observed.binding.command_id) {
            old.close();
        }
    }
    result
}
pub(super) fn bound(
    held: &mut Held,
    caller: &Process,
    context: &DescriptorContext,
    observed: &Graph,
    effect: &str,
) -> Result<Option<super::destination::BoundObservation>, String> {
    let digest = graph(held, caller, context, observed)?;
    let evidence = capture(held, &digest, observed)?.evidence(now_ms()?)?;
    let result = held
        .destination
        .as_ref()
        .ok_or(REJECTED)?
        .observe_bound_effect(observed, evidence, effect)?;
    held.recheck()?;
    capture(held, &digest, observed)?.current(now_ms()?)?;
    Ok(result)
}
pub(super) fn observe(
    held: &mut Held,
    caller: &Process,
    context: &DescriptorContext,
    observed: &Graph,
    effect: &str,
) -> Result<Value, String> {
    Ok(json!({"bound":bound(held, caller, context, observed, effect)?}))
}
