//! Pairing is machine-first. The code is display-only; the runtime keeps the key.
//! The person's claim in Nessie completes it: nothing is confirmed here, and
//! the status check that first reads `paired` starts the team's connection.
//!
//! **Add this computer** always pairs under this person's account, so agents can
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
use std::sync::Mutex;

use crate::{
    commands, pairing_origin,
    pipe_client::{call, service_control, ServiceResponse},
    state::{Connection, ServiceView},
};

/// The code on screen and the server it was asked of. **Open Nessie** adds it
/// to the Computers page while it shows; the page never passes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShowingCode {
    pub api_origin: String,
    pub code: String,
}

static SHOWING: Mutex<Option<ShowingCode>> = Mutex::new(None);

pub fn showing_code() -> Option<ShowingCode> {
    SHOWING.lock().ok().and_then(|showing| showing.clone())
}

/// What a pairing answer means for the code on screen: a waiting attempt shows
/// its code; any other state shows none.
fn shown_by(view: &serde_json::Value, asked_of: Option<&str>, previous: Option<&ShowingCode>) -> Option<ShowingCode> {
    if view["status"] != "waiting" {
        return None;
    }
    let code = view["code"].as_str()?.to_owned();
    let api_origin = view["apiBaseUrl"].as_str().or(asked_of)
        .or(previous.filter(|previous| previous.code == code).map(|previous| previous.api_origin.as_str()))?
        .to_owned();
    Some(ShowingCode { api_origin, code })
}

fn pairing(response: Result<ServiceResponse, String>, asked_of: Option<&str>) -> Result<serde_json::Value, String> {
    match response? {
        ServiceResponse::Pairing(view) => {
            if let Ok(mut showing) = SHOWING.lock() {
                *showing = shown_by(&view, asked_of, showing.as_ref());
            }
            Ok(view)
        }
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

/// A team this app runs, which is the only kind a plan connection is added for.
fn user_team<'a>(view: &'a ServiceView, executor_id: &str) -> Result<&'a crate::state::ExecutorStatus, String> {
    let ServiceView::Reachable { executors } = view else {
        return Err("The Nessie Computer service can’t be reached, and ChatGPT plans need it.".to_owned());
    };
    let executor = executors.iter().find(|executor| executor.executor_id == executor_id)
        .ok_or("This team is not connected on this computer.")?;
    if executor.connection == Connection::Service {
        return Err("This team’s connection already holds ChatGPT plans. Add the plan to it directly.".to_owned());
    }
    Ok(executor)
}

/// The team a plan connection is for: one this app runs, without one yet.
fn check_plan_connection(view: &ServiceView, executor_id: &str) -> Result<(), String> {
    let executor = user_team(view, executor_id)?;
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
        pairing(call(&serde_json::json!({ "command": "pairingStart", "apiBaseUrl": origin })), Some(&origin))
    })
    .await
    .map_err(|_| "Pairing could not be started.".to_owned())?
}

#[tauri::command]
pub async fn executor_pairing_status(executor_id: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let looking_up_a_team = executor_id.is_some();
        let view = call(&serde_json::json!({ "command": "pairingStatus", "executorId": executor_id }));
        if looking_up_a_team {
            // A connected team's name lookup, not the attempt on screen.
            return match view? {
                ServiceResponse::Pairing(view) => Ok(view),
                _ => Err("Nessie could not read the pairing status.".to_owned()),
            };
        }
        pairing(view, None)
    })
    .await
    .map_err(|_| "Pairing status could not be read.".to_owned())?
}

#[tauri::command]
pub async fn executor_pairing_cancel() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || pairing(call(&serde_json::json!({ "command": "pairingCancel" })), None))
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
        pairing(service_control(&service_start_request(&origin, &workspace)), Some(&origin))
    })
    .await
    .map_err(|_| "The ChatGPT plan connection could not be started.".to_owned())?
}

/// The plan connection being added for this team: its pairing view.
#[tauri::command]
pub async fn executor_chatgpt_connection_status(executor_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        user_team(&commands::view(), &executor_id)?;
        pairing(service_control(&serde_json::json!({ "command": "pairingStatus" })), None)
    })
    .await
    .map_err(|_| "Pairing status could not be read.".to_owned())?
}

#[tauri::command]
pub async fn executor_chatgpt_connection_cancel(executor_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        user_team(&commands::view(), &executor_id)?;
        pairing(service_control(&serde_json::json!({ "command": "pairingCancel" })), None)
    })
    .await
    .map_err(|_| "Pairing could not be cancelled.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::{check_plan_connection, service_start_request, shown_by, ShowingCode};
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

    #[test]
    fn open_nessie_carries_the_code_only_while_it_is_on_screen() {
        let waiting = serde_json::json!({ "status": "waiting", "code": "12345678", "expiresAt": "2026-11-08T10:10:00Z" });
        let shown = shown_by(&waiting, Some("https://api.nessie.works"), None).unwrap();
        assert_eq!(shown, ShowingCode { api_origin: "https://api.nessie.works".to_owned(), code: "12345678".to_owned() });
        // A later status check of the same attempt keeps the server it was asked of.
        assert_eq!(shown_by(&waiting, None, Some(&shown)), Some(shown.clone()));
        let named = serde_json::json!({ "status": "waiting", "code": "87654321", "apiBaseUrl": "https://nessie.acme.example" });
        assert_eq!(shown_by(&named, None, Some(&shown)).unwrap().api_origin, "https://nessie.acme.example");
        // A new code from an unknown server is not guessed.
        assert_eq!(shown_by(&serde_json::json!({ "status": "waiting", "code": "87654321" }), None, Some(&shown)), None);
        for status in ["paired", "expired", "cancelled", "idle"] {
            assert_eq!(shown_by(&serde_json::json!({ "status": status, "code": "12345678" }), None, Some(&shown)), None);
        }
    }
}
