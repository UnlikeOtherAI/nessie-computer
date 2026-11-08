//! What the tray can do, in one place.
//!
//! The right-click menu and the window are two ways of reaching the same
//! actions, so they call these functions rather than each carrying their own
//! copy. The CLI is the only reader and writer of private executor state. Teams
//! this app connects run under this person's account; the service's own teams
//! are addressed through its authenticated pipe. Resource edits live in
//! `console_commands`, the owner's controls in `owner_commands`.

use nessie_windows_common::LOGS_DIRECTORY;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::{
    nessie_desktop, pairing_origin,
    pipe_client::{call, ServiceResponse},
    service_identity::{console_url, service_root},
    state::{Connection, ServiceView},
    team_names::{self, same_team},
};

const UNREADABLE: &str = "Nessie Computer couldn’t understand its service’s reply. Try again, or restart Nessie Computer.";

/// On a team this app runs, names the service connection to the same team
/// that holds its ChatGPT plans, from the names the rows carry.
fn link_chatgpt_connections(view: &mut ServiceView) {
    let ServiceView::Reachable { executors } = view else { return };
    let services: Vec<(String, team_names::TeamIdentity)> = executors.iter()
        .filter(|executor| executor.connection == Connection::Service)
        .filter_map(|executor| executor.names.clone().map(|identity| (executor.executor_id.clone(), identity)))
        .collect();
    for executor in executors.iter_mut().filter(|executor| executor.connection == Connection::User) {
        executor.chatgpt_connection_id = executor.names.as_ref().and_then(|mine| {
            services.iter().find(|(_, theirs)| same_team(mine, theirs)).map(|(id, _)| id.clone())
        });
    }
}

/// The service's answer, with a failure turned into the view that says so
/// rather than into an empty list.
pub fn view() -> ServiceView {
    let mut view = match call(&serde_json::json!({ "command": "status" })) {
        Ok(ServiceResponse::Status(executors)) => ServiceView::Reachable { executors },
        Ok(_) => ServiceView::Unreachable { reason: UNREADABLE.to_owned() },
        Err(reason) => ServiceView::Unreachable { reason },
    };
    if let ServiceView::Reachable { executors } = &mut view {
        team_names::remember(executors);
    }
    link_chatgpt_connections(&mut view);
    view
}

/// A refusal a person did not ask for by clicking something in the window
/// still has to reach them; the menu has nowhere to render one.
pub fn notify<R: Runtime>(app: &AppHandle<R>, title: &'static str, message: String) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().message(message).title(title).blocking_show();
    });
}

/// The server Open Nessie goes to when no team is named: the first listed
/// team's, or this build's default when nothing is connected yet.
pub fn default_server() -> String {
    if let ServiceView::Reachable { executors } = view() {
        if let Some(identity) = executors.into_iter().find_map(|executor| executor.names) {
            return identity.api_base_url;
        }
    }
    pairing_origin::default_origin(cfg!(debug_assertions)).to_owned()
}

/// The server a team is paired with: from its saved name, or, for a team that
/// has never had one, from its own settings.
pub fn team_server(executor_id: &str) -> Result<String, String> {
    if let Some(identity) = team_names::snapshot().get(executor_id) {
        return Ok(identity.api_base_url.clone());
    }
    match call(&serde_json::json!({ "command": "describe", "executorId": executor_id })) {
        Ok(ServiceResponse::Describe(description)) => description["apiBaseUrl"].as_str().map(str::to_owned)
            .ok_or_else(|| UNREADABLE.to_owned()),
        Ok(_) => Err(UNREADABLE.to_owned()),
        Err(reason) => Err(reason),
    }
}

/// Opens the Computers page of the given server. Hosted Nessie opens in
/// Nessie Desktop when this person has it, unless a pairing code has to reach
/// the page, which only the browser can be given. Which branch fired, and
/// why, is logged.
pub fn open_nessie<R: Runtime>(app: &AppHandle<R>, server: &str, code: Option<&str>) -> Result<(), String> {
    let origin = pairing_origin::approve(server, cfg!(debug_assertions))?.origin;
    let url = console_url(&origin, cfg!(debug_assertions), code)?;
    if origin == pairing_origin::NESSIE_PRESET_ORIGIN && code.is_none() {
        match nessie_desktop::installed().and_then(|executable| {
            nessie_desktop::launch(&executable).map(|()| executable)
        }) {
            Ok(executable) => {
                eprintln!("Open Nessie: launched Nessie Desktop at {}.", executable.display());
                return Ok(());
            }
            Err(reason) => eprintln!("Open Nessie: opening the web console. {reason}"),
        }
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "Nessie Computer could not open your browser.".to_owned())
}

pub fn open_logs<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let logs = service_root()?.join(LOGS_DIRECTORY);
    // The service creates the folder when it first writes to it; opening a path
    // that is not there yet would show a shell error instead of an explanation.
    if !logs.is_dir() {
        return Err("The Nessie Computer service has not written any logs yet.".to_owned());
    }
    app.opener()
        .open_path(logs.display().to_string(), None::<&str>)
        .map_err(|_| "Nessie Computer could not open the logs folder.".to_owned())
}

/// The window is created hidden at launch so a left-click shows it at once.
pub fn show_status<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("status") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub async fn choose_folder<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let file_path = app
            .dialog()
            .file()
            .set_title("Choose a folder this team may read")
            .blocking_pick_folder()?;
        file_path.into_path().ok().map(|path| resolved_folder(&path))
    })
    .await
    .map_err(|_| "Nessie Computer could not open its folder picker.".to_owned())?)
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

#[tauri::command]
pub async fn executor_view() -> Result<ServiceView, String> {
    tauri::async_runtime::spawn_blocking(view).await.map_err(|error| error.to_string())
}

/// Opens a team's Nessie: the Computers page of the server that team is
/// paired with. With no team, the attempt whose pairing code is on screen
/// (with that code, on **Add a computer**), or else the first team's server.
/// The page names only a team; the address is always this app's own.
/// Opens one computer's own page in Nessie. Always the browser: Nessie
/// Desktop opens on its own start page.
pub fn open_computer<R: Runtime>(app: &AppHandle<R>, executor_id: &str) -> Result<(), String> {
    let origin = pairing_origin::approve(&team_server(executor_id)?, cfg!(debug_assertions))?.origin;
    let url = crate::service_identity::computer_url(&origin, cfg!(debug_assertions), executor_id)?;
    app.opener().open_url(url, None::<&str>).map_err(|_| "Nessie Computer could not open Nessie.".to_owned())
}

/// `computer` opens that team's computer page rather than the Computers list.
#[tauri::command]
pub async fn executor_open_nessie(app: AppHandle, executor_id: Option<String>, computer: Option<bool>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || match executor_id {
        Some(executor_id) if computer == Some(true) => open_computer(&app, &executor_id),
        Some(executor_id) => open_nessie(&app, &team_server(&executor_id)?, None),
        None => match crate::pairing_code::showing_code() {
            Some(showing) => open_nessie(&app, &showing.api_origin, Some(&showing.code)),
            None => open_nessie(&app, &default_server(), None),
        },
    })
    .await
    .map_err(|error| error.to_string())?
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
pub async fn executor_choose_folder(app: AppHandle) -> Result<Option<String>, String> {
    choose_folder(app).await
}

#[cfg(test)]
mod tests {
    use super::without_verbatim_prefix;

    #[test]
    fn a_resolved_folder_reads_as_the_runtime_stores_it() {
        assert_eq!(without_verbatim_prefix(r"\\?\C:\Users\Person\Nessie"), r"C:\Users\Person\Nessie");
        assert_eq!(without_verbatim_prefix(r"\\?\UNC\server\share\work"), r"\\server\share\work");
        assert_eq!(without_verbatim_prefix("/Users/person/Nessie"), "/Users/person/Nessie");
    }
}
