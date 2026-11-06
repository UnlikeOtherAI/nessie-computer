//! Machine-wide update settings are available even before a team is connected.
use serde::Deserialize;
use tauri::{AppHandle, Emitter};

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum LocalRequest {
    Status,
    Check,
    Install,
    Automatic { enabled: bool },
    Remind,
}

fn call(request: LocalRequest) -> Result<serde_json::Value, String> {
    let value = match request {
        LocalRequest::Status => serde_json::json!({ "operation": "status" }),
        LocalRequest::Check => serde_json::json!({ "operation": "check" }),
        LocalRequest::Install => serde_json::json!({ "operation": "install" }),
        LocalRequest::Automatic { enabled } => serde_json::json!({ "operation": "automatic", "enabled": enabled }),
        LocalRequest::Remind => serde_json::json!({ "operation": "remind" }),
    };
    #[cfg(windows)]
    return nessie_windows_common::update_channel::call(&value, option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"));
    #[cfg(not(windows))]
    { let _ = value; Err("update.coordinator_unavailable".into()) }
}

#[tauri::command]
pub async fn executor_update_control(request: LocalRequest) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || call(request)).await
        .map_err(|_| "update.coordinator_unavailable".to_owned())?
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut announced = None;
        loop {
            if let Ok(status) = call(LocalRequest::Status) {
                #[cfg(windows)]
                if status["draining"] == true && status["phase"] == "waiting" {
                    let answer = nessie_windows_common::update_channel::call(
                        &serde_json::json!({"operation":"app_ready"}),
                        option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"),
                    );
                    if answer.is_ok_and(|value| value["mayExit"] == true) {
                        // The SYSTEM broker independently proved all runtime
                        // jobs idle and retained this account's restart plan.
                        app.exit(0);
                        return;
                    }
                }
                if status["canInstall"] == true && (status["draining"] != true
                    || status["phase"] == "restarting" && status["installedVersion"] == status["targetVersion"]) {
                    crate::personal_chatgpt::resume_updates();
                }
                let version = status["availableVersion"].as_str();
                let notify = status["notify"] == true && status["automatic"] == false
                    && status["canInstall"] == true && version.is_some();
                if notify && version != announced.as_deref() {
                    announced = version.map(str::to_owned);
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        crate::commands::show_status(&handle);
                        let _ = handle.emit_to("status", "tray://section/settings", ());
                        let _ = handle.emit_to("status", "executor://update-available", &status);
                    });
                } else if !notify { announced = None; }
            }
            std::thread::sleep(std::time::Duration::from_secs(15));
        }
    });
}
