//! Independent SQL acceptance checks for the captured original callbacks.
use super::read::{self, schema, snapshot};
use nessie_windows_common::{
    custody::REJECTED,
    execution::{now_ms, Graph},
    execution_command_lineage::{self as lineage, AcceptedInitial, AcceptedRelease, Evidence, Initial, EVENT_COLUMNS},
    execution_json,
    execution_pending_effect::{Observation, RECEIPT_COLUMNS},
    execution_resource_handles::HeldObject,
    readonly_sqlite::Connection,
};
use serde::Serialize;
use serde_json::Value;

fn receipt(connection: &mut Connection, command: &str, thread: &str) -> Result<Value, String> {
    connection
        .read_one(
            "SELECT * FROM orchestration_command_receipts
        WHERE command_id = ? AND aggregate_kind = 'thread' AND aggregate_id = ?",
            &[command, thread],
        )?
        .ok_or_else(|| REJECTED.into())
}
fn event(connection: &mut Connection, command: &str, thread: &str, released: bool) -> Result<Value, String> {
    connection
        .read_one(
            "SELECT * FROM orchestration_events
        WHERE command_id = ? AND aggregate_kind = 'thread' AND stream_id = ? AND event_type = ?",
            &[command, thread, if released { "run.updated" } else { "run.created" }],
        )?
        .ok_or_else(|| REJECTED.into())
}
fn initial(connection: &mut Connection, graph: &Graph, first: &Initial, run: &str) -> Result<AcceptedInitial, String> {
    schema(connection, "orchestration_command_receipts", RECEIPT_COLUMNS)?;
    schema(connection, "orchestration_events", EVENT_COLUMNS)?;
    let b = &graph.binding;
    let parent = receipt(connection, &b.command_id, &b.thread_id)?;
    let child = receipt(connection, &first.command_id, &b.thread_id)?;
    let run_event = event(connection, &first.command_id, &b.thread_id, false)?;
    if parent["result_sequence"]
        .as_i64()
        .is_none_or(|end| run_event["sequence"].as_i64().is_none_or(|start| start <= end))
    {
        return Err(REJECTED.into());
    }
    Ok(AcceptedInitial {
        run_id: run.into(),
        parent_receipt_digest: lineage::receipt(
            &parent,
            &b.command_id,
            &b.thread_id,
            &["thread.create", "thread.metadata.update"],
        )?,
        parent_command_type: parent["command_type"].as_str().ok_or(REJECTED)?.into(),
        initial_receipt_digest: lineage::receipt(&child, &first.command_id, &b.thread_id, &["message.dispatch"])?,
        initial_run_event_digest: lineage::run_event(
            &run_event,
            &child,
            &first.command_id,
            &b.thread_id,
            run,
            &first.message_id,
            &b.provider_instance_id,
            false,
        )?,
    })
}
fn released(
    connection: &mut Connection,
    graph: &Graph,
    first: &Initial,
    run: &str,
    release: &str,
) -> Result<AcceptedRelease, String> {
    let b = &graph.binding;
    let receipt = receipt(connection, release, &b.thread_id)?;
    let run_event = event(connection, release, &b.thread_id, true)?;
    let initial = self::receipt(connection, &first.command_id, &b.thread_id)?;
    if initial["result_sequence"]
        .as_i64()
        .is_none_or(|end| run_event["sequence"].as_i64().is_none_or(|start| start <= end))
    {
        return Err(REJECTED.into());
    }
    Ok(AcceptedRelease {
        receipt_digest: lineage::receipt(&receipt, release, &b.thread_id, &["prepared-run.release"])?,
        run_event_digest: lineage::run_event(
            &run_event,
            &receipt,
            release,
            &b.thread_id,
            run,
            &first.message_id,
            &b.provider_instance_id,
            true,
        )?,
    })
}
pub(super) fn accept_initial(
    main: &HeldObject,
    owner: &str,
    graph: &Graph,
    first: &Initial,
    run: &str,
) -> Result<AcceptedInitial, String> {
    snapshot(main, owner, |connection| initial(connection, graph, first, run))
}
pub(super) fn accept_release(
    main: &HeldObject,
    owner: &str,
    graph: &Graph,
    first: &Initial,
    accepted: &AcceptedInitial,
    release: &str,
) -> Result<AcceptedRelease, String> {
    snapshot(main, owner, |connection| {
        if initial(connection, graph, first, &accepted.run_id)? != *accepted {
            return Err(REJECTED.into());
        }
        released(connection, graph, first, &accepted.run_id, release)
    })
}
#[derive(Serialize)]
pub(crate) struct BoundObservation {
    pub observation: Observation,
    pub original: Evidence,
}
pub(super) fn observe(
    main: &HeldObject,
    owner: &str,
    graph: &Graph,
    evidence: Evidence,
    effect: &str,
) -> Result<Option<BoundObservation>, String> {
    let observed_at = now_ms()?;
    snapshot(main, owner, |connection| {
        let Some((observation, row)) = read::pending(connection, &graph.binding.thread_id, effect, observed_at)? else {
            return Ok(None);
        };
        if observation.command_id != evidence.release_command_id
            || observation.effect_type != "provider-turn.start"
            || observation.command_type != "prepared-run.release"
        {
            return Ok(None);
        }
        let payload = execution_json::parse(row["payload_json"].as_str().ok_or(REJECTED)?.as_bytes())?;
        if payload["runId"] != evidence.run_id {
            return Ok(None);
        }
        let first = Initial {
            command_id: evidence.initial_command_id.clone(),
            message_id: evidence.message_id.clone(),
        };
        let accepted = initial(connection, graph, &first, &evidence.run_id)?;
        let released = released(
            connection,
            graph,
            &first,
            &evidence.run_id,
            &evidence.release_command_id,
        )?;
        if accepted.parent_command_type != evidence.parent_command_type
            || accepted.parent_receipt_digest != evidence.parent_receipt_digest
            || accepted.initial_receipt_digest != evidence.initial_receipt_digest
            || accepted.initial_run_event_digest != evidence.initial_run_event_digest
            || released.receipt_digest != evidence.release_receipt_digest
            || released.run_event_digest != evidence.release_run_event_digest
            || observation.receipt_digest != evidence.release_receipt_digest
        {
            return Err(REJECTED.into());
        }
        Ok(Some(BoundObservation {
            observation,
            original: evidence,
        }))
    })
}
