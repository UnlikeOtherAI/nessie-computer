//! What the tray can do, in one place.
//!
//! The right-click menu and the status window are two ways of reaching the same
//! actions, so they call these functions rather than each carrying their own
//! copy — a second implementation of "stop this executor" is exactly the kind
//! of fork that ends with two surfaces disagreeing about what a confirmation
//! says.
//!
//! The CLI is the only reader and writer of private executor state. New
//! connections run under this user's account; existing service connections
//! are addressed through the authenticated pipe. Resource edits live in
//! console_commands and use the CLI's complete local configuration contract.

use nessie_windows_common::LOGS_DIRECTORY;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

use crate::{
    nessie_desktop, pairing_origin,
    pipe_client::{call, ServiceResponse},
    service_identity::{executors_url_for_api, service_root},
    state::{short_id, ExecutorStatus, ServiceView},
    user_connections::RUNNING_ELSEWHERE,
};

/// The service's answer, with a failure turned into the view that says so
/// rather than into an empty list.
pub fn view() -> ServiceView {
    match call(&serde_json::json!({ "command": "status" })) {
        Ok(ServiceResponse::Status(executors)) => ServiceView::Reachable { executors },
        Ok(_) => ServiceView::Unreachable {
            reason: "Nessie Executor couldn’t understand its service’s reply. Try again, or restart Nessie Executor.".to_owned(),
        },
        Err(reason) => ServiceView::Unreachable { reason },
    }
}

async fn confirm<R: Runtime>(
    app: AppHandle<R>,
    title: &'static str,
    message: String,
    action: &'static str,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title(title)
            .buttons(MessageDialogButtons::OkCancelCustom(action.to_owned(), "Cancel".to_owned()))
            .blocking_show()
    })
    .await
    .map_err(|_| "Nessie Executor could not show its confirmation dialog.".to_owned())
}

/// A refusal a person did not ask for by clicking something in a window still
/// has to reach them; the menu has nowhere to render one.
pub fn notify<R: Runtime>(app: &AppHandle<R>, title: &'static str, message: String) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().message(message).title(title).blocking_show();
    });
}

pub async fn start<R: Runtime>(app: AppHandle<R>, executor_id: String) -> Result<ServiceView, String> {
    if !confirm(
        app,
        "Start Nessie executor",
        "Start this locally paired executor with the permissions configured on this computer."
            .to_owned(),
        "Start executor",
    )
    .await?
    {
        return Err("Starting the executor was cancelled.".to_owned());
    }
    let response = tauri::async_runtime::spawn_blocking(move || {
        call(&serde_json::json!({ "command": "start", "executorId": executor_id }))
    }).await.map_err(|error| error.to_string())??;
    match response {
        ServiceResponse::Status(executors) => Ok(ServiceView::Reachable { executors }),
        _ => Err("Nessie Executor couldn’t understand its service’s reply. Try again, or restart Nessie Executor.".to_owned()),
    }
}

pub async fn stop<R: Runtime>(app: AppHandle<R>, executor_id: String) -> Result<ServiceView, String> {
    if !confirm(
        app,
        "Stop Nessie executor",
        "Stopping this executor ends its daemon connection and asks every active browser or \
         coding sandbox to tear down."
            .to_owned(),
        "Stop executor",
    )
    .await?
    {
        return Err("Stopping the executor was cancelled.".to_owned());
    }
    let response = tauri::async_runtime::spawn_blocking(move || {
        call(&serde_json::json!({ "command": "stop", "executorId": executor_id }))
    }).await.map_err(|error| error.to_string())??;
    match response {
        ServiceResponse::Status(executors) => Ok(ServiceView::Reachable { executors }),
        _ => Err("Nessie Executor couldn’t understand its service’s reply. Try again, or restart Nessie Executor.".to_owned()),
    }
}

/// Applies one switch to every connection, attempting all of them before
/// answering. A connection another app or CLI runs is that app's to control,
/// so it is skipped rather than reported. `act` is the per-connection start or
/// stop, passed in so the policy is tested without a service.
fn apply_to_every_connection(
    executors: &[ExecutorStatus],
    running: bool,
    mut act: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    let failures: Vec<String> = executors
        .iter()
        .filter(|executor| executor.daemon_status != RUNNING_ELSEWHERE)
        .filter_map(|executor| {
            act(&executor.executor_id)
                .err()
                .map(|reason| format!("Connection {}: {reason}", short_id(&executor.executor_id)))
        })
        .collect();
    if failures.is_empty() {
        return Ok(());
    }
    let verb = if running { "started" } else { "stopped" };
    Err(format!("Some teams could not be {verb}. {}", failures.join(" ")))
}

/// The console's global switch. The switch itself is the person's
/// confirmation, so unlike the menu's per-team Start and Stop there is no
/// dialog. Nothing is remembered: the next launch starts every paired
/// connection, as it always has.
pub fn set_running(running: bool) -> Result<ServiceView, String> {
    let executors = match view() {
        ServiceView::Reachable { executors } => executors,
        ServiceView::Unreachable { reason } => return Err(reason),
    };
    let command = if running { "start" } else { "stop" };
    apply_to_every_connection(&executors, running, |executor_id| {
        call(&serde_json::json!({ "command": command, "executorId": executor_id })).map(|_| ())
    })?;
    Ok(view())
}

/// Production Nessie opens in Nessie Desktop when this person has it
/// installed; everything else opens the web console. Which branch fired, and
/// why, is logged: a person asking why the browser opened deserves an answer.
pub fn open_nessie<R: Runtime>(app: &AppHandle<R>, backend: &str) -> Result<(), String> {
    let origin = pairing_origin::resolve(backend, None, cfg!(debug_assertions))?.origin;
    if origin == pairing_origin::NESSIE_PRESET_ORIGIN {
        match nessie_desktop::installed().and_then(|executable| {
            nessie_desktop::launch(&executable).map(|()| executable)
        }) {
            Ok(executable) => {
                eprintln!("Open Nessie: launched Nessie Desktop at {}.", executable.display());
                return Ok(());
            }
            // The web console is the same destination, so a person who asked
            // to open Nessie still gets there when Desktop cannot be used.
            Err(reason) => eprintln!("Open Nessie: opening the web console. {reason}"),
        }
    } else {
        eprintln!("Open Nessie: opening the web console for {origin}; Nessie Desktop serves production only.");
    }
    app.opener()
        .open_url(executors_url_for_api(&origin)?, None::<&str>)
        .map_err(|_| "Nessie Executor could not open your browser.".to_owned())
}

pub fn open_logs<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let logs = service_root()?.join(LOGS_DIRECTORY);
    // The service creates the folder when it first writes to it; opening a path
    // that is not there yet would show a shell error instead of an explanation.
    if !logs.is_dir() {
        return Err("The Nessie Executor service has not written any logs yet.".to_owned());
    }
    app.opener()
        .open_path(logs.display().to_string(), None::<&str>)
        .map_err(|_| "Nessie Executor could not open the logs folder.".to_owned())
}

/// The status window is created hidden at launch so a left-click shows it
/// immediately; there is no main window at any point.
pub fn show_status<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("status") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub async fn choose_folder<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let file_path = app
            .dialog()
            .file()
            .set_title("Choose a folder this executor may read")
            .blocking_pick_folder()?;
        file_path.into_path().ok().map(|path| resolved_folder(&path))
    })
    .await
    .map_err(|_| "Nessie Executor could not open its folder picker.".to_owned())?)
}

/// The path the runtime will store for a chosen folder: fully resolved, as
/// Node's `realpath` gives it, without the `\\?\` prefix Rust's resolution adds.
/// The console keeps this path, so what it asked for and what is saved compare
/// equal. A folder that cannot be resolved is returned as chosen, and the
/// runtime's own validation explains why it is refused.
fn resolved_folder(path: &std::path::Path) -> String {
    std::fs::canonicalize(path)
        .map(|resolved| without_verbatim_prefix(&resolved.display().to_string()))
        .unwrap_or_else(|_| path.display().to_string())
}

fn without_verbatim_prefix(path: &str) -> String {
    if let Some(share) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{share}");
    }
    path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
}

#[cfg(test)]
mod resolved_folder_tests {
    use super::without_verbatim_prefix;

    #[test]
    fn a_resolved_folder_reads_as_the_runtime_stores_it() {
        assert_eq!(without_verbatim_prefix(r"\\?\C:\Users\Person\Nessie"), r"C:\Users\Person\Nessie");
        assert_eq!(without_verbatim_prefix(r"\\?\UNC\server\share\work"), r"\\server\share\work");
        assert_eq!(without_verbatim_prefix("/Users/person/Nessie"), "/Users/person/Nessie");
    }
}

#[tauri::command]
pub async fn executor_view() -> Result<ServiceView, String> {
    tauri::async_runtime::spawn_blocking(view).await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn executor_start(app: AppHandle, executor_id: String) -> Result<ServiceView, String> {
    start(app, executor_id).await
}

#[tauri::command]
pub async fn executor_stop(app: AppHandle, executor_id: String) -> Result<ServiceView, String> {
    stop(app, executor_id).await
}

/// One team back on, with no dialog: the console's Try again after a saved
/// change whose connection dropped. The team's own start, nothing else.
#[tauri::command]
pub async fn executor_reconnect(executor_id: String) -> Result<ServiceView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        call(&serde_json::json!({ "command": "start", "executorId": executor_id }))?;
        Ok(view())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn executor_set_running(running: bool) -> Result<ServiceView, String> {
    tauri::async_runtime::spawn_blocking(move || set_running(running))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn executor_open_nessie(app: AppHandle, api_base_url: String) -> Result<(), String> {
    open_nessie(&app, &api_base_url)
}

#[cfg(test)]
mod open_nessie_tests {
    use crate::{pairing_origin, service_identity::executors_url_for_api};

    /// The console may send the preset id or the origin; both resolve to the
    /// production origin, which is the one Nessie Desktop is chosen for.
    #[test]
    fn the_status_window_nessie_preset_resolves_before_opening() {
        for backend in ["nessie", "https://api.nessie.works"] {
            let origin = pairing_origin::resolve(backend, None, false).expect("production resolves").origin;
            assert_eq!(origin, pairing_origin::NESSIE_PRESET_ORIGIN);
            assert_eq!(executors_url_for_api(&origin), Ok("https://app.nessie.works/admin/computers"));
        }
        let deeptest = pairing_origin::resolve("deeptest", None, false).expect("DeepTest resolves").origin;
        assert_ne!(deeptest, pairing_origin::NESSIE_PRESET_ORIGIN);
    }
}

#[cfg(test)]
mod set_running_tests {
    use super::apply_to_every_connection;
    use crate::state::ExecutorStatus;

    fn connection(id: &str, daemon_status: &str) -> ExecutorStatus {
        ExecutorStatus {
            daemon_status: daemon_status.to_owned(),
            executor_id: id.to_owned(),
            workspace_configured: true,
        }
    }

    #[test]
    fn every_connection_this_app_controls_is_switched_and_one_run_elsewhere_is_left_alone() {
        let executors = [
            connection("aaaaaaaa-0000-4000-8000-000000000001", "stopped"),
            connection("bbbbbbbb-0000-4000-8000-000000000002", "running elsewhere"),
            connection("cccccccc-0000-4000-8000-000000000003", "running"),
        ];
        let mut switched = Vec::new();
        assert_eq!(
            apply_to_every_connection(&executors, true, |id| {
                switched.push(id.to_owned());
                Ok(())
            }),
            Ok(()),
        );
        assert_eq!(
            switched,
            ["aaaaaaaa-0000-4000-8000-000000000001", "cccccccc-0000-4000-8000-000000000003"],
        );
    }

    #[test]
    fn a_failure_does_not_stop_the_rest_and_every_failure_is_named() {
        let executors = [
            connection("aaaaaaaa-0000-4000-8000-000000000001", "running"),
            connection("bbbbbbbb-0000-4000-8000-000000000002", "running"),
            connection("cccccccc-0000-4000-8000-000000000003", "running"),
        ];
        let mut attempted = 0;
        let outcome = apply_to_every_connection(&executors, false, |id| {
            attempted += 1;
            if id.starts_with('b') { Ok(()) } else { Err("The executor is still stopping.".to_owned()) }
        });
        assert_eq!(attempted, 3);
        assert_eq!(
            outcome,
            Err("Some teams could not be stopped. Connection aaaaaaaa: The executor is still stopping. \
                 Connection cccccccc: The executor is still stopping."
                .to_owned()),
        );
    }
}

#[tauri::command]
pub fn executor_pairing_backends() -> Vec<(&'static str, &'static str)> {
    pairing_origin::backend_choices(cfg!(debug_assertions))
}

#[tauri::command]
pub fn executor_open_logs(app: AppHandle) -> Result<(), String> {
    open_logs(&app)
}

#[tauri::command]
pub fn executor_hide_status(app: AppHandle) {
    if let Some(window) = app.get_webview_window("status") {
        let _ = window.hide();
    }
}

#[tauri::command]
pub async fn executor_choose_folder(app: AppHandle) -> Result<Option<String>, String> {
    choose_folder(app).await
}
