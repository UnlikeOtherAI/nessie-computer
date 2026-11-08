//! The owner's controls, for every team on this computer whoever runs it.
//!
//! Pause and Resume act on a team, not a connection: a team this app runs and
//! the service's ChatGPT plan connection to the same team pause together, or
//! agents would keep working through the one left running. Each connection is
//! paused by whoever runs it — this app for its own, the service for its own —
//! through the CLI, so the pause is durable and the daemon enforces it.

use nessie_windows_common::{
    failure::Remedy,
    owner_controls::{Answer, ProgramRequest},
};
use tauri::AppHandle;

use crate::{
    commands,
    overview::group,
    pipe_client::{call, ServiceResponse},
    state::{ExecutorStatus, ServiceView},
    team_names,
};

const UNREADABLE: &str = "Nessie Computer couldn’t understand its service’s reply. Try again.";

fn listed() -> Result<Vec<ExecutorStatus>, String> {
    match commands::view() {
        ServiceView::Reachable { executors } => Ok(executors),
        ServiceView::Unreachable { reason } => Err(reason),
    }
}

/// The connections a pause names: every one, or every connection of the team
/// the named connection belongs to.
pub fn pause_targets(executors: &[ExecutorStatus], executor_id: Option<&str>) -> Result<Vec<String>, String> {
    let ids = |team: &[&ExecutorStatus]| team.iter().map(|executor| executor.executor_id.clone()).collect::<Vec<_>>();
    let names = team_names::snapshot();
    let teams = group(executors, &names);
    match executor_id {
        None => Ok(teams.iter().flat_map(|team| ids(team)).collect()),
        Some(executor_id) => teams.iter()
            .find(|team| team.iter().any(|executor| executor.executor_id == executor_id))
            .map(|team| ids(team))
            .ok_or_else(|| "This team is not connected on this computer.".to_owned()),
    }
}

/// Pauses or resumes, trying every connection before answering.
pub fn set_paused(executor_id: Option<&str>, paused: bool) -> Result<ServiceView, String> {
    let targets = pause_targets(&listed()?, executor_id)?;
    let failures: Vec<String> = targets.iter().filter_map(|id| {
        call(&serde_json::json!({ "command": "setPaused", "executorId": id, "paused": paused })).err()
    }).collect();
    if let Some(first) = failures.into_iter().next() {
        return Err(first);
    }
    Ok(commands::view())
}

fn restart(executor_id: &str) -> Result<(), String> {
    call(&serde_json::json!({ "command": "stop", "executorId": executor_id }))?;
    call(&serde_json::json!({ "command": "start", "executorId": executor_id }))?;
    Ok(())
}

/// Proposes the team's current settings again as a newer revision, then
/// reconnects. Nothing about what the team may do changes.
fn repropose(executor_id: &str) -> Result<(), String> {
    let ServiceResponse::Describe(current) = call(&serde_json::json!({ "command": "describe", "executorId": executor_id }))? else {
        return Err(UNREADABLE.to_owned());
    };
    let input = serde_json::json!({
        "operationKeys": current["policy"]["operations"],
        "workspaceFolders": current["reach"]["folders"],
    });
    call(&serde_json::json!({ "command": "configureInput", "executorId": executor_id, "configurationInput": input }))?;
    restart(executor_id)
}

pub fn apply_remedy(app: &AppHandle, executor_id: &str, remedy: Remedy) -> Result<ServiceView, String> {
    if !listed()?.iter().any(|executor| executor.executor_id == executor_id) {
        return Err("This team is not connected on this computer.".to_owned());
    }
    match remedy {
        Remedy::Restart => restart(executor_id)?,
        Remedy::Repropose => repropose(executor_id)?,
        Remedy::OpenNessie => commands::open_nessie(app, &commands::team_server(executor_id)?, None)?,
    }
    Ok(commands::view())
}

/// One request with the team it belongs to, as the console lists them.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRequest {
    pub executor_id: String,
    #[serde(flatten)]
    pub request: ProgramRequest,
}

fn team_requests(executor_id: &str, response: ServiceResponse) -> Result<Vec<TeamRequest>, String> {
    let ServiceResponse::ProgramRequests(requests) = response else {
        return Err(UNREADABLE.to_owned());
    };
    Ok(requests.into_iter().map(|request| TeamRequest { executor_id: executor_id.to_owned(), request }).collect())
}

pub fn program_requests_for(executor_id: &str) -> Result<Vec<TeamRequest>, String> {
    team_requests(executor_id, call(&serde_json::json!({ "command": "programRequests", "executorId": executor_id }))?)
}

/// Every team's waiting requests. A team whose list cannot be read is left
/// out rather than failing the others; its count still shows on its row.
pub fn all_program_requests() -> Result<Vec<TeamRequest>, String> {
    Ok(listed()?.iter()
        .filter(|executor| executor.pending_program_requests > 0)
        .filter_map(|executor| program_requests_for(&executor.executor_id).ok())
        .flatten()
        .collect())
}

pub fn answer(executor_id: &str, id: &str, answer: Answer) -> Result<Vec<TeamRequest>, String> {
    team_requests(executor_id, call(&serde_json::json!({
        "command": "answerProgramRequest", "executorId": executor_id, "id": id, "answer": answer.as_str(),
    }))?)?;
    all_program_requests()
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn executor_set_paused(executor_id: Option<String>, paused: bool) -> Result<ServiceView, String> {
    blocking(move || set_paused(executor_id.as_deref(), paused)).await
}

#[tauri::command]
pub async fn executor_apply_remedy(app: AppHandle, executor_id: String, remedy: String) -> Result<ServiceView, String> {
    blocking(move || apply_remedy(&app, &executor_id, Remedy::parse(&remedy)?)).await
}

#[tauri::command]
pub async fn executor_audience(executor_id: String) -> Result<serde_json::Value, String> {
    blocking(move || match call(&serde_json::json!({ "command": "audience", "executorId": executor_id }))? {
        ServiceResponse::Audience(audience) => Ok(audience),
        _ => Err(UNREADABLE.to_owned()),
    }).await
}

#[tauri::command]
pub async fn executor_program_requests(executor_id: Option<String>) -> Result<Vec<TeamRequest>, String> {
    blocking(move || match executor_id {
        Some(executor_id) => program_requests_for(&executor_id),
        None => all_program_requests(),
    }).await
}

#[tauri::command]
pub async fn executor_answer_program_request(
    executor_id: String,
    id: String,
    answer: String,
) -> Result<Vec<TeamRequest>, String> {
    blocking(move || self::answer(&executor_id, &id, Answer::parse(&answer)?)).await
}

#[cfg(test)]
mod tests {
    use super::{pause_targets, TeamRequest};
    use crate::state::tests::executor;
    use nessie_windows_common::owner_controls::ProgramRequest;

    #[test]
    fn pausing_all_names_every_connection_and_one_team_names_only_its_own() {
        let executors = [executor("a", "running", false), executor("b", "running", false)];
        assert_eq!(pause_targets(&executors, None).unwrap(), ["a", "b"]);
        assert_eq!(pause_targets(&executors, Some("b")).unwrap(), ["b"]);
        assert!(pause_targets(&executors, Some("c")).is_err());
    }

    #[test]
    fn a_listed_request_carries_its_team_beside_the_clis_fields() {
        let row = TeamRequest {
            executor_id: "a".to_owned(),
            request: ProgramRequest {
                id: "r1".to_owned(), program: "python".to_owned(), args: vec!["build.py".to_owned()],
                agent_name: None, requested_at: "2026-11-08T10:00:00.000Z".to_owned(),
                expires_at: "2026-11-08T10:02:00.000Z".to_owned(),
            },
        };
        assert_eq!(serde_json::to_value(row).unwrap(), serde_json::json!({
            "executorId": "a", "id": "r1", "program": "python", "args": ["build.py"],
            "requestedAt": "2026-11-08T10:00:00.000Z", "expiresAt": "2026-11-08T10:02:00.000Z",
        }));
    }
}
