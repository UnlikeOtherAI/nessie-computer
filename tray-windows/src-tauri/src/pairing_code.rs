//! Pairing is machine-first. The code is display-only; the runtime keeps the key.
//! The person's claim in Nessie completes it: nothing is confirmed here, and
//! the status check that first reads `paired` starts the daemon.
//! Ordinary connections keep the owner's installed coding tools. An explicit
//! personal-plan choice instead grants its workspace through the UAC helper;
//! the unelevated caller, never the approving administrator, starts that code.
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use crate::{
    pairing_origin,
    pipe_client::{call, ServiceResponse},
};

fn request(payload: serde_json::Value, personal_plan: bool) -> Result<serde_json::Value, String> {
    request_with(
        personal_plan,
        || call(&payload),
        || crate::pipe_client::service_control(&payload),
    )
}
fn request_with(
    personal_plan: bool,
    local: impl FnOnce() -> Result<ServiceResponse, String>,
    service: impl FnOnce() -> Result<ServiceResponse, String>,
) -> Result<serde_json::Value, String> {
    let response = if personal_plan { service() } else { local() }?;
    match response {
        ServiceResponse::Pairing(view) => Ok(view),
        _ => Err("Nessie could not read the pairing status.".to_owned()),
    }
}

fn start_request(origin: &str, workspace: &std::path::Path, replace: bool) -> serde_json::Value {
    serde_json::json!({"command":"pairingStart", "apiBaseUrl":origin,
        "workspaceRoot":workspace.display().to_string(), "replace":replace})
}

#[cfg(windows)]
fn prepare_workspace() -> Result<std::path::PathBuf, String> {
    let workspace = nessie_windows_common::process::interactive_profile()
        .map_err(|_| "Pair from the Windows account currently signed in.".to_owned())?
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
    Err("Windows service pairing is unavailable.".into())
}

#[tauri::command]
pub async fn executor_pairing_start(
    app: AppHandle,
    replace: bool,
    api_base_url: String,
    personal_plan_connection: Option<bool>,
) -> Result<serde_json::Value, String> {
    let origin = pairing_origin::approve(&api_base_url, cfg!(debug_assertions))?.origin;
    if replace {
        let current = request(
            serde_json::json!({ "command": "pairingStatus" }),
            personal_plan_connection == Some(true),
        )?;
        let organisation = current
            .get("organizationName")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Nessie");
        let team = current
            .get("teamName")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("No team");
        let approved = app.dialog().message(format!("This computer is paired to {organisation}, {team}. Close that pairing and create a new one?"))
            .title("Replace pairing").buttons(MessageDialogButtons::OkCancelCustom("Replace pairing".to_owned(), "Cancel".to_owned()))
            .blocking_show();
        if !approved {
            return Err("Pairing was cancelled.".to_owned());
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        if personal_plan_connection == Some(true) {
            let workspace = prepare_workspace()?;
            request(start_request(&origin, &workspace, replace), true)
        } else {
            request(serde_json::json!({"command":"pairingStart", "apiBaseUrl":origin, "replace":replace}), false)
        }
    }).await.map_err(|_| "Pairing could not be started.".to_owned())?
}

#[tauri::command]
pub async fn executor_pairing_status(
    executor_id: Option<String>,
    personal_plan_connection: Option<bool>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        request(
            serde_json::json!({ "command": "pairingStatus", "executorId": executor_id }),
            personal_plan_connection == Some(true),
        )
    })
    .await
    .map_err(|_| "Pairing status could not be read.".to_owned())?
}

#[tauri::command]
pub async fn executor_pairing_cancel(
    personal_plan_connection: Option<bool>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        request(
            serde_json::json!({ "command": "pairingCancel" }),
            personal_plan_connection == Some(true),
        )
    })
    .await
    .map_err(|_| "Pairing could not be cancelled.".to_owned())?
}

#[cfg(test)]
mod tests {
    #[test]
    fn explicit_personal_choice_reaches_service_without_local_key_fallback_or_default_tool_regression(
    ) {
        let value = serde_json::json!({"status":"waiting"});
        assert_eq!(
            super::request_with(
                false,
                || Ok(super::ServiceResponse::Pairing(value.clone())),
                || panic!("ordinary Add team must remain interactive")
            )
            .unwrap(),
            value
        );
        assert_eq!(
            super::request_with(
                true,
                || panic!("service refusal must not create a user pairing"),
                || Err("service unavailable".into())
            )
            .unwrap_err(),
            "service unavailable"
        );
        assert_eq!(
            super::request_with(
                true,
                || panic!("personal code belongs only to the service"),
                || Ok(super::ServiceResponse::Pairing(value.clone()))
            )
            .unwrap(),
            value
        );
    }
    #[test]
    fn the_existing_add_team_code_request_names_the_service_workspace_but_no_owner_or_key() {
        let request = super::start_request(
            "https://nessie.example",
            std::path::Path::new(r"C:\Users\actual\Nessie"),
            false,
        );
        assert_eq!(request["command"], "pairingStart");
        assert_eq!(request["workspaceRoot"], r"C:\Users\actual\Nessie");
        assert_eq!(request.as_object().unwrap().len(), 4);
        assert!(request.get("sid").is_none() && request.get("machinePrivateKey").is_none());
    }
}
