//! Pairing is machine-first. The code is display-only; the runtime keeps the key.
//! The person's claim in Nessie completes it: nothing is confirmed here, and
//! the status check that first reads `paired` starts the team's connection.
//!
//! **Connect a team** always pairs under this person's account, so agents can
//! use the coding tools installed there. It offers no ChatGPT option.
//!
//! **ChatGPT plans on Windows** need the background service: only it can hold
//! a plan's sign-in in custody, never a copy of a user-session key. So when the
//! AI tab adds the first plan for a team this app runs, it asks for a second,
//! service-owned connection to the same team's server — one more pairing code
//! the owner enters in Nessie, and one UAC prompt that lets the service read
//! the owner's `Nessie` folder. The unelevated caller, never the approving
//! administrator, starts that code. Once it is claimed, the view links the two
//! (`chatgptConnectionId`) and plans are signed in on the service connection.
use crate::{
    commands, pairing_origin,
    pipe_client::{call, service_control, ServiceResponse},
    state::{Connection, ServiceView},
};

fn pairing(response: Result<ServiceResponse, String>) -> Result<serde_json::Value, String> {
    match response? {
        ServiceResponse::Pairing(view) => Ok(view),
        _ => Err("Nessie could not read the pairing status.".to_owned()),
    }
}

fn service_start_request(origin: &str, workspace: &std::path::Path) -> serde_json::Value {
    serde_json::json!({"command":"pairingStart", "apiBaseUrl":origin,
        "workspaceRoot":workspace.display().to_string(), "replace":false})
}

#[cfg(windows)]
fn prepare_workspace() -> Result<std::path::PathBuf, String> {
    let workspace = nessie_windows_common::process::interactive_profile()
        .map_err(|_| "Add the plan from the Windows account that is signed in.".to_owned())?
        .join("Nessie");
    std::fs::create_dir_all(&workspace).map_err(|_| "Could not prepare your Nessie folder.")?;
    let metadata = std::fs::symlink_metadata(&workspace)
        .map_err(|_| "Could not inspect your Nessie folder.")?;
    use std::os::windows::fs::MetadataExt;
    if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
        return Err("Choose an ordinary Nessie folder under your Windows profile.".into());
    }
    crate::grant::request_workspace_grant(&workspace)?;
    Ok(workspace)
}
#[cfg(not(windows))]
fn prepare_workspace() -> Result<std::path::PathBuf, String> {
    Err("ChatGPT plans need the Windows service.".into())
}

/// The team a plan connection is for: one this app runs, without one yet.
fn check_plan_connection(view: &ServiceView, executor_id: &str) -> Result<(), String> {
    let ServiceView::Reachable { executors } = view else {
        return Err("The Nessie Computer service can’t be reached, and ChatGPT plans need it.".to_owned());
    };
    let executor = executors.iter().find(|executor| executor.executor_id == executor_id)
        .ok_or("This team is not connected on this computer.")?;
    if executor.connection == Connection::Service {
        return Err("This team’s connection already holds ChatGPT plans. Add the plan to it directly.".to_owned());
    }
    if executor.chatgpt_connection_id.is_some() {
        return Err("This team already has its ChatGPT plan connection.".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub async fn executor_pairing_start(api_base_url: Option<String>) -> Result<serde_json::Value, String> {
    let requested = api_base_url.unwrap_or_else(|| pairing_origin::default_origin(cfg!(debug_assertions)).to_owned());
    let origin = pairing_origin::approve(&requested, cfg!(debug_assertions))?.origin;
    tauri::async_runtime::spawn_blocking(move || {
        pairing(call(&serde_json::json!({ "command": "pairingStart", "apiBaseUrl": origin })))
    })
    .await
    .map_err(|_| "Pairing could not be started.".to_owned())?
}

#[tauri::command]
pub async fn executor_pairing_status(executor_id: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pairing(call(&serde_json::json!({ "command": "pairingStatus", "executorId": executor_id })))
    })
    .await
    .map_err(|_| "Pairing status could not be read.".to_owned())?
}

#[tauri::command]
pub async fn executor_pairing_cancel() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || pairing(call(&serde_json::json!({ "command": "pairingCancel" }))))
        .await
        .map_err(|_| "Pairing could not be cancelled.".to_owned())?
}

/// Starts the service-owned connection a ChatGPT plan needs for a team this
/// app runs, on that team's own server. Answers the pairing view: its code,
/// expiry and status, as `executor_pairing_start` does.
#[tauri::command]
pub async fn executor_chatgpt_connection_start(executor_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_plan_connection(&commands::view(), &executor_id)?;
        let origin = pairing_origin::approve(&commands::team_server(&executor_id)?, cfg!(debug_assertions))?.origin;
        let workspace = prepare_workspace()?;
        pairing(service_control(&service_start_request(&origin, &workspace)))
    })
    .await
    .map_err(|_| "The ChatGPT plan connection could not be started.".to_owned())?
}

#[tauri::command]
pub async fn executor_chatgpt_connection_status() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| pairing(service_control(&serde_json::json!({ "command": "pairingStatus" }))))
        .await
        .map_err(|_| "Pairing status could not be read.".to_owned())?
}

#[tauri::command]
pub async fn executor_chatgpt_connection_cancel() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| pairing(service_control(&serde_json::json!({ "command": "pairingCancel" }))))
        .await
        .map_err(|_| "Pairing could not be cancelled.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::{check_plan_connection, service_start_request};
    use crate::state::{tests::executor, Connection, ServiceView};

    #[test]
    fn the_service_code_request_names_its_workspace_but_no_owner_or_key() {
        let request = service_start_request("https://nessie.example", std::path::Path::new(r"C:\Users\actual\Nessie"));
        assert_eq!(request["command"], "pairingStart");
        assert_eq!(request["workspaceRoot"], r"C:\Users\actual\Nessie");
        assert_eq!(request["replace"], false);
        assert_eq!(request.as_object().unwrap().len(), 4);
        assert!(request.get("sid").is_none() && request.get("machinePrivateKey").is_none());
    }

    #[test]
    fn a_plan_connection_is_added_once_and_only_for_a_team_this_app_runs() {
        let mine = executor("mine", "running", false);
        let mut linked = executor("linked", "running", false);
        linked.chatgpt_connection_id = Some("plans".to_owned());
        let mut service = executor("plans", "running", false);
        service.connection = Connection::Service;
        let view = ServiceView::Reachable { executors: vec![mine, linked, service] };
        assert_eq!(check_plan_connection(&view, "mine"), Ok(()));
        assert!(check_plan_connection(&view, "linked").is_err());
        assert!(check_plan_connection(&view, "plans").is_err());
        assert!(check_plan_connection(&view, "missing").is_err());
        assert!(check_plan_connection(&ServiceView::Unreachable { reason: "down".to_owned() }, "mine").is_err());
    }
}
