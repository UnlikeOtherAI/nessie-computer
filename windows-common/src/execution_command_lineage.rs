//! Live protected-original capture. These unsigned facts authorize no effect.
use crate::{
    custody::REJECTED,
    execution::{identifier, value_digest},
    execution_json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    cell::Cell,
    time::{Duration, Instant},
};
#[cfg(test)]
#[path = "execution_command_lineage_tests.rs"]
mod tests;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "phase",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Edge {
    InitialCreated {
        parent_command_id: String,
        command_id: String,
        thread_id: String,
        message_id: String,
    },
    InitialAccepted {
        parent_command_id: String,
        command_id: String,
        thread_id: String,
        message_id: String,
        run_id: String,
    },
    ReleaseCreated {
        parent_command_id: String,
        command_id: String,
        thread_id: String,
        run_id: String,
    },
    ReleaseAccepted {
        parent_command_id: String,
        command_id: String,
        thread_id: String,
        run_id: String,
    },
}
fn id(value: &str) -> bool {
    identifier(value) && value.len() <= 256 && !value.chars().any(char::is_control)
}
impl Edge {
    pub fn values(&self) -> (&str, &str, &str, Option<&str>, Option<&str>) {
        match self {
            Self::InitialCreated {
                parent_command_id,
                command_id,
                thread_id,
                message_id,
            } => (parent_command_id, command_id, thread_id, Some(message_id), None),
            Self::InitialAccepted {
                parent_command_id,
                command_id,
                thread_id,
                message_id,
                run_id,
            } => (parent_command_id, command_id, thread_id, Some(message_id), Some(run_id)),
            Self::ReleaseCreated {
                parent_command_id,
                command_id,
                thread_id,
                run_id,
            }
            | Self::ReleaseAccepted {
                parent_command_id,
                command_id,
                thread_id,
                run_id,
            } => (parent_command_id, command_id, thread_id, None, Some(run_id)),
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        let (parent, command, thread, message, run) = self.values();
        if ![parent, command, thread].into_iter().all(id)
            || parent == command
            || message.is_some_and(|value| !id(value))
            || run.is_some_and(|value| !id(value))
        {
            return Err(REJECTED.into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Initial {
    pub command_id: String,
    pub message_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptedInitial {
    pub run_id: String,
    pub parent_command_type: String,
    pub parent_receipt_digest: String,
    pub initial_receipt_digest: String,
    pub initial_run_event_digest: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptedRelease {
    pub receipt_digest: String,
    pub run_event_digest: String,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub parent_command_id: String,
    pub parent_command_type: String,
    pub initial_command_id: String,
    pub release_command_id: String,
    pub thread_id: String,
    pub message_id: String,
    pub run_id: String,
    pub provider_instance_id: String,
    pub parent_receipt_digest: String,
    pub initial_receipt_digest: String,
    pub initial_run_event_digest: String,
    pub release_receipt_digest: String,
    pub release_run_event_digest: String,
}
pub struct Capture {
    pub graph_digest: String,
    pub expires_at_ms: u64,
    parent: String,
    thread: String,
    provider: String,
    initial: Option<Initial>,
    accepted: Option<AcceptedInitial>,
    release: Option<String>,
    released: Option<AcceptedRelease>,
    closed: Cell<bool>,
    started: Instant,
    valid_for: Duration,
}
impl Capture {
    pub fn new(
        graph_digest: String,
        parent: String,
        thread: String,
        provider: String,
        expires_at_ms: u64,
        observed_at_ms: u64,
    ) -> Self {
        Self {
            graph_digest,
            expires_at_ms,
            parent,
            thread,
            provider,
            initial: None,
            accepted: None,
            release: None,
            released: None,
            closed: Cell::new(false),
            started: Instant::now(),
            valid_for: Duration::from_millis(expires_at_ms.saturating_sub(observed_at_ms)),
        }
    }
    pub fn close(&mut self) {
        self.closed.set(true);
    }
    pub fn current(&self, now: u64) -> Result<(), String> {
        if self.closed.get() || now >= self.expires_at_ms || self.started.elapsed() >= self.valid_for {
            self.closed.set(true);
            return Err(REJECTED.into());
        }
        Ok(())
    }
    pub fn initial(&self) -> Option<&Initial> {
        self.initial.as_ref()
    }
    pub fn accepted(&self) -> Option<&AcceptedInitial> {
        self.accepted.as_ref()
    }
    pub fn record(
        &mut self,
        edge: &Edge,
        initial: Option<AcceptedInitial>,
        release: Option<AcceptedRelease>,
        now: u64,
    ) -> Result<(), String> {
        let result = (|| {
            self.current(now)?;
            edge.validate()?;
            let (parent, command, thread, message, run) = edge.values();
            if parent != self.parent || thread != self.thread {
                return Err(REJECTED.into());
            }
            match edge {
                Edge::InitialCreated { .. } => {
                    let next = Initial {
                        command_id: command.into(),
                        message_id: message.ok_or(REJECTED)?.into(),
                    };
                    if self.initial.as_ref().is_some_and(|old| old != &next) {
                        return Err(REJECTED.into());
                    }
                    self.initial.get_or_insert(next);
                }
                Edge::InitialAccepted { .. } => {
                    let first = self.initial.as_ref().ok_or(REJECTED)?;
                    let next = initial.ok_or(REJECTED)?;
                    if first.command_id != command
                        || Some(first.message_id.as_str()) != message
                        || Some(next.run_id.as_str()) != run
                        || self.accepted.as_ref().is_some_and(|old| old != &next)
                    {
                        return Err(REJECTED.into());
                    }
                    self.accepted.get_or_insert(next);
                }
                Edge::ReleaseCreated { .. } | Edge::ReleaseAccepted { .. } => {
                    if self.initial.as_ref().is_none_or(|first| first.command_id == command)
                        || self
                            .accepted
                            .as_ref()
                            .is_none_or(|accepted| Some(accepted.run_id.as_str()) != run)
                    {
                        return Err(REJECTED.into());
                    }
                    if self.release.as_deref().is_some_and(|old| old != command) {
                        return Err(REJECTED.into());
                    }
                    if matches!(edge, Edge::ReleaseCreated { .. }) {
                        self.release.get_or_insert(command.into());
                    } else {
                        if self.release.as_deref() != Some(command) {
                            return Err(REJECTED.into());
                        }
                        let next = release.ok_or(REJECTED)?;
                        if self.released.as_ref().is_some_and(|old| old != &next) {
                            return Err(REJECTED.into());
                        }
                        self.released.get_or_insert(next);
                    }
                }
            }
            Ok(())
        })();
        if result.is_err() {
            self.close();
        }
        result
    }
    pub fn evidence(&self, now: u64) -> Result<Evidence, String> {
        self.current(now)?;
        let first = self.initial.as_ref().ok_or(REJECTED)?;
        let accepted = self.accepted.as_ref().ok_or(REJECTED)?;
        let release = self.release.as_ref().ok_or(REJECTED)?;
        let released = self.released.as_ref().ok_or(REJECTED)?;
        Ok(Evidence {
            parent_command_id: self.parent.clone(),
            parent_command_type: accepted.parent_command_type.clone(),
            initial_command_id: first.command_id.clone(),
            release_command_id: release.clone(),
            thread_id: self.thread.clone(),
            message_id: first.message_id.clone(),
            run_id: accepted.run_id.clone(),
            provider_instance_id: self.provider.clone(),
            parent_receipt_digest: accepted.parent_receipt_digest.clone(),
            initial_receipt_digest: accepted.initial_receipt_digest.clone(),
            initial_run_event_digest: accepted.initial_run_event_digest.clone(),
            release_receipt_digest: released.receipt_digest.clone(),
            release_run_event_digest: released.run_event_digest.clone(),
        })
    }
}
pub fn receipt(value: &Value, command: &str, thread: &str, types: &[&str]) -> Result<String, String> {
    if value.as_object().is_none_or(|row| {
        row.len() != 8
            || crate::execution_pending_effect::RECEIPT_COLUMNS
                .iter()
                .any(|name| !row.contains_key(*name))
    }) || value["command_id"] != command
        || value["aggregate_kind"] != "thread"
        || value["aggregate_id"] != thread
        || value["status"] != "accepted"
        || !value["error"].is_null()
        || value["accepted_at"].as_str().is_none_or(|v| !id(v))
        || value["result_sequence"]
            .as_i64()
            .is_none_or(|v| !(0..=9_007_199_254_740_991).contains(&v))
        || value["command_type"].as_str().is_none_or(|v| !types.contains(&v))
    {
        return Err(REJECTED.into());
    }
    value_digest(value)
}
pub const EVENT_COLUMNS: &[&str] = &[
    "sequence",
    "event_id",
    "aggregate_kind",
    "stream_id",
    "stream_version",
    "event_type",
    "occurred_at",
    "command_id",
    "causation_event_id",
    "correlation_id",
    "actor_kind",
    "payload_json",
    "metadata_json",
    "application_event_version",
];
pub fn run_event(
    event: &Value,
    receipt: &Value,
    command: &str,
    thread: &str,
    run: &str,
    message: &str,
    provider: &str,
    released: bool,
) -> Result<String, String> {
    let payload = execution_json::parse(event["payload_json"].as_str().ok_or(REJECTED)?.as_bytes())?;
    let metadata = execution_json::parse(event["metadata_json"].as_str().ok_or(REJECTED)?.as_bytes())?;
    if event
        .as_object()
        .is_none_or(|row| row.len() != EVENT_COLUMNS.len() || EVENT_COLUMNS.iter().any(|name| !row.contains_key(*name)))
        || event["aggregate_kind"] != "thread"
        || event["stream_id"] != thread
        || event["command_id"] != command
        || event["correlation_id"] != command
        || !event["causation_event_id"].is_null()
        || event["actor_kind"] != "server"
        || event["application_event_version"] != 2
        || event["event_type"] != if released { "run.updated" } else { "run.created" }
        || event["sequence"]
            .as_i64()
            .is_none_or(|n| n <= 0 || receipt["result_sequence"].as_i64().is_none_or(|end| n > end))
        || event["stream_version"].as_i64().is_none_or(|n| n < 0)
        || event["event_id"].as_str().is_none_or(|v| !id(v))
        || event["occurred_at"].as_str().is_none_or(|v| !id(v))
        || !payload.is_object()
        || !metadata.is_object()
        || payload["id"] != run
        || payload["threadId"] != thread
        || payload["userMessageId"] != message
        || payload["providerInstanceId"] != provider
        || payload["modelSelection"]["instanceId"] != provider
        || metadata["runId"] != run
        || metadata["providerInstanceId"] != provider
        || payload["status"] != if released { "starting" } else { "preparing" }
    {
        return Err(REJECTED.into());
    }
    value_digest(event)
}
