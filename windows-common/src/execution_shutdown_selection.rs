//! Pure selector from pinned RestartContinuation at 25bf84ab (MIT).
use super::{Effect, Policy, Target};
use crate::{custody::REJECTED, execution_codec::trimmed, execution_json};
use serde_json::Value;
use std::collections::BTreeMap;

/// Private actual SQL input; neither this struct nor its payloads cross a wire.
pub struct Projection {
    pub thread: Value,
    pub sections: BTreeMap<String, Vec<Value>>,
}
impl Projection {
    pub fn decode(thread: &str, rows: &[(String, String)]) -> Result<Self, String> {
        let thread = execution_json::parse(thread.as_bytes())?;
        let mut sections = BTreeMap::<String, Vec<Value>>::new();
        for (section, payload) in rows {
            sections
                .entry(section.clone())
                .or_default()
                .push(execution_json::parse(payload.as_bytes())?);
        }
        Ok(Self { thread, sections })
    }
    pub fn target(&self, expected_thread: &str, input_digest: &str) -> Result<Target, String> {
        let thread_id = id(&self.thread, "id")?;
        if thread_id != expected_thread {
            return Err(REJECTED.into());
        }
        Ok(Target {
            thread_id,
            project_id: id(&self.thread, "projectId")?,
            input_digest: input_digest.into(),
        })
    }
    fn rows(&self, section: &str) -> &[Value] {
        self.sections.get(section).map(Vec::as_slice).unwrap_or(&[])
    }
}
fn id(value: &Value, key: &str) -> Result<String, String> {
    trimmed(&value[key])
}
fn optional_id(value: &Value, key: &str) -> Result<Option<String>, String> {
    if value[key].is_null() {
        Ok(None)
    } else {
        id(value, key).map(Some)
    }
}
fn time(value: &Value) -> Result<Option<i64>, String> {
    if value.is_null() {
        return Ok(None);
    }
    chrono::DateTime::parse_from_rfc3339(value.as_str().ok_or(REJECTED)?)
        .map(|value| Some(value.timestamp_millis()))
        .map_err(|_| REJECTED.into())
}
fn ordinal(value: &Value) -> Result<u64, String> {
    value["ordinal"]
        .as_u64()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| REJECTED.into())
}
fn active(value: &Value) -> bool {
    matches!(
        value["status"].as_str(),
        Some("pending" | "running" | "waiting")
    )
}
fn awaited(projection: &Projection, provider: &Value) -> Result<bool, String> {
    let provider_id = id(provider, "id")?;
    for item in projection
        .rows("turnItems")
        .iter()
        .filter(|item| active(item))
    {
        if item["type"] == "subagent"
            && item["origin"] == "app_owned"
            && !item["childThreadId"].is_null()
        {
            continue;
        }
        let work = item["type"] == "subagent"
            || item["type"] == "dynamic_tool" && item["input"]["persistent"] != true;
        if !work {
            continue;
        }
        let run_id = optional_id(item, "runId")?;
        let mut run_provider = None;
        for run in projection.rows("runs") {
            if Some(id(run, "id")?) == run_id {
                run_provider = optional_id(run, "providerThreadId")?;
                break;
            }
        }
        let own = optional_id(item, "providerThreadId")?;
        let owner = if item["type"] == "subagent" && item["origin"] == "provider_native" {
            run_provider.or(own)
        } else {
            own.or(run_provider)
        };
        if owner.as_ref() == Some(&provider_id) {
            return Ok(true);
        }
    }
    if provider["ownerNodeId"].is_null() {
        if let Some(tasks) = provider.get("pendingBackgroundTasks") {
            for task in tasks.as_array().ok_or(REJECTED)? {
                let kind = task["kind"].as_str().ok_or(REJECTED)?;
                if task.get("parentTaskId").is_some()
                    || task["awaited"] == true
                    || !matches!(kind, "command" | "monitor")
                {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

/// Same original selector, without labels, transcript output or provider calls.
pub fn select(
    projection: &Projection,
    policy: &Policy,
    at_ms: u64,
) -> Result<Option<Effect>, String> {
    let thread = &projection.thread;
    let thread_id = id(thread, "id")?;
    let project_id = id(thread, "projectId")?;
    if !policy
        .overrides
        .get(&project_id)
        .copied()
        .unwrap_or(policy.enabled)
    {
        return Ok(None);
    }
    let mut selected: Option<&Value> = None;
    for run in projection.rows("runs") {
        if run["status"] == "queued"
            || run["startedAt"].is_null() && run.get("restartContinuationOfRunId").is_none()
        {
            continue;
        }
        let newer = if let Some(previous) = selected {
            let end = time(&run["completedAt"])?.unwrap_or(i64::MAX);
            let previous_end = time(&previous["completedAt"])?.unwrap_or(i64::MAX);
            end > previous_end || end == previous_end && ordinal(run)? > ordinal(previous)?
        } else {
            true
        };
        if newer {
            selected = Some(run);
        }
    }
    let Some(run) = selected else {
        return Ok(None);
    };
    let prepared = run["status"] == "starting" && run.get("restartContinuationOfRunId").is_some();
    let settled = run["status"] == "completed" || run["status"] == "waiting";
    if run["status"] != "running" && !prepared && !settled {
        return Ok(None);
    }
    if !thread["archivedAt"].is_null()
        || !thread["deletedAt"].is_null()
        || thread["settledOverride"] == "settled"
        || time(&thread["snoozedUntil"])?.is_some_and(|value| value as i128 > at_ms as i128)
    {
        return Ok(None);
    }
    let attempt_id = optional_id(run, "activeAttemptId")?;
    let mut latest_turn: Option<&Value> = None;
    for turn in projection.rows("providerTurns") {
        if attempt_id.is_some()
            && optional_id(turn, "runAttemptId")? == attempt_id
            && (latest_turn.is_none() || ordinal(turn)? > ordinal(latest_turn.unwrap())?)
        {
            latest_turn = Some(turn);
        }
    }
    if !settled
        && latest_turn.is_some_and(|turn| {
            matches!(
                turn["status"].as_str(),
                Some("completed" | "failed" | "interrupted")
            )
        })
    {
        return Ok(None);
    }
    for request in projection.rows("runtimeRequests") {
        if request["kind"] == "dynamic_tool_call"
            || request["kind"] == "auth_refresh"
            || request["responseCapability"]["type"] == "message"
        {
            continue;
        }
        let old = matches!(request["status"].as_str(), Some("expired" | "cancelled"))
            && request["responseCapability"]["type"] == "not_resumable"
            && latest_turn.map(|turn| id(turn, "id")).transpose()?
                == optional_id(request, "providerTurnId")?
            && latest_turn.is_some();
        if request["status"] == "pending" || old {
            return Ok(None);
        }
    }
    let source_run = id(run, "id")?;
    for item in projection.rows("turnItems") {
        if item["type"] == "secret_request"
            && optional_id(item, "runId")?.as_ref() == Some(&source_run)
        {
            if item["secretStatus"] == "pending"
                || item["secretStatus"] == "cancelled"
                    && time(&item["completedAt"])?.is_some()
                    && time(&run["completedAt"])?.is_some()
                    && time(&item["completedAt"])? == time(&run["completedAt"])?
            {
                return Ok(None);
            }
        }
    }
    let instance = id(run, "providerInstanceId")?;
    if id(thread, "providerInstanceId")? != instance {
        return Ok(None);
    }
    let provider_id = optional_id(run, "providerThreadId")?;
    let mut provider = None;
    for value in projection.rows("providerThreads") {
        if Some(id(value, "id")?) == provider_id {
            provider = Some(value);
            break;
        }
    }
    let Some(provider) = provider else {
        return Ok(None);
    };
    let live_turn_required = !prepared && !settled;
    if id(provider, "appThreadId")? != thread_id
        || !provider["ownerNodeId"].is_null()
        || id(provider, "providerInstanceId")? != instance
        || provider["nativeThreadRef"]["nativeId"].is_null()
        || provider["nativeThreadRef"]["strength"] != "strong"
        || provider["nativeThreadRef"]["driver"] != provider["driver"]
        || live_turn_required && provider["status"] != "active"
        || matches!(provider["status"].as_str(), Some("closed" | "archived"))
    {
        return Ok(None);
    }
    let session_id = id(provider, "providerSessionId")?;
    let mut session = None;
    for value in projection.rows("providerSessions") {
        if id(value, "id")? == session_id {
            session = Some(value);
            break;
        }
    }
    let Some(session) = session else {
        return Ok(None);
    };
    if id(session, "providerInstanceId")? != instance
        || session["driver"] != provider["driver"]
        || !prepared && matches!(session["status"].as_str(), Some("stopped" | "error"))
    {
        return Ok(None);
    }
    if settled && !awaited(projection, provider)? {
        return Ok(None);
    }
    if live_turn_required {
        let mut running = false;
        for turn in projection.rows("providerTurns") {
            if optional_id(turn, "providerThreadId")? == provider_id
                && optional_id(turn, "runAttemptId")? == attempt_id
                && turn["status"] == "running"
            {
                running = true;
            }
        }
        if !running {
            return Ok(None);
        }
    }
    Ok(Some(Effect {
        thread_id,
        effect_id: format!("effect:restart-continuation:{source_run}"),
        command_id: format!("command:restart-prepare:{source_run}"),
        source_run_id: source_run,
        existing_row_digest: None,
    }))
}
