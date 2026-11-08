//! Commands reachable only from the bundled, local executor console.
use tauri::AppHandle;
use crate::{pipe_client::{call, ServiceResponse}, state::ServiceView};

fn describe(executor_id: &str) -> Result<serde_json::Value, String> {
    match call(&serde_json::json!({ "command": "describe", "executorId": executor_id }))? {
        ServiceResponse::Describe(value) => Ok(value),
        _ => Err("Couldn’t load this team’s settings. Try again.".into()),
    }
}

#[tauri::command]
pub async fn executor_console_describe(executor_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || describe(&executor_id)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn executor_configure(
    _app: AppHandle, executor_id: String, configuration_input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let current = describe(&executor_id)?;
        // Only legacy service connections need an explicit service-account ACL.
        if !crate::user_connections::owns(&executor_id) {
        if let Some(folders) = configuration_input.get("workspaceFolders").and_then(|v| v.as_array()) {
            for folder in folders {
                if let Some(path) = folder.get("path").and_then(|v| v.as_str()) {
                    let existed = current["reach"]["folders"].as_array().is_some_and(|old| {
                        old.iter().any(|entry| entry["path"].as_str() == Some(path))
                    });
                    if !existed { crate::grant::request_workspace_grant(std::path::Path::new(path))?; }
                }
            }
        }
        }
        call(&serde_json::json!({ "command": "configureInput", "executorId": executor_id,
            "configurationInput": configuration_input }))?;
        describe(&executor_id)
    }).await.map_err(|error| error.to_string())?
}

/// Removes one team's connection from this computer after the console's own
/// confirmation. Only a connection this computer lists can be removed; the
/// route (this app's session or the service) follows who owns it, and the
/// answer says whether Nessie heard the sign-off.
fn remove(executor_id: &str) -> Result<serde_json::Value, String> {
    let listed = match crate::commands::view() {
        ServiceView::Reachable { executors } => executors.iter().any(|executor| executor.executor_id == executor_id),
        ServiceView::Unreachable { reason } => return Err(reason),
    };
    if !listed { return Err("This team is not paired on this computer.".into()); }
    match call(&serde_json::json!({ "command": "remove", "executorId": executor_id }))? {
        ServiceResponse::Removed { signed_off } => Ok(serde_json::json!({ "signedOff": signed_off })),
        _ => Err("Couldn’t confirm whether this team was removed. Check Teams.".into()),
    }
}

#[tauri::command]
pub async fn executor_remove(executor_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || remove(&executor_id)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn executor_autostart() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "enabled": autostart::enabled()? }))
}

#[tauri::command]
pub fn executor_set_autostart(enabled: bool) -> Result<(), String> { autostart::set(enabled) }

#[tauri::command]
pub fn executor_auto_restart() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "enabled": crate::restart_setting::enabled()? }))
}

#[tauri::command]
pub fn executor_set_auto_restart(enabled: bool) -> Result<(), String> { crate::restart_setting::set(enabled) }

#[tauri::command]
pub fn executor_copy_code(code: String) -> Result<(), String> {
    if code.len() != 8 || !code.bytes().all(|digit| digit.is_ascii_digit()) { return Err("Invalid pairing code.".into()); }
    #[cfg(windows)]
    {
        use std::io::Write;
        use std::os::windows::process::CommandExt;
        let mut process = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "$input | Set-Clipboard"])
            .creation_flags(0x08000000).stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .spawn().map_err(|_| "Could not copy the code.".to_owned())?;
        process.stdin.take().ok_or("Could not copy the code.")?.write_all(code.as_bytes()).map_err(|e| e.to_string())?;
        if !process.wait().map_err(|e| e.to_string())?.success() { return Err("Could not copy the code.".into()); }
        Ok(())
    }
    #[cfg(not(windows))]
    Err("This works on Windows only.".into())
}

// ── Folder sync ────────────────────────────────────────────────────────────
//
// The page names a team, a choice and public identifiers. Every path this
// app opens comes from the CLI's own `sync status --json`, and every change
// goes to `nessie-executor sync --input-stdin` as JSON, never on argv.

const SYNC_UNAVAILABLE: &str = "Documents sync for teams connected in this app under your Windows account.";
const SYNC_INVALID: &str = "Invalid folder sync action.";

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// Sync runs only for a connection this account owns: its state is the
/// person's own, and a service connection's folder would belong to the service.
fn sync_cli(
    executor_id: &str, tail: &[&str], input: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if !is_uuid(executor_id) { return Err("Invalid team identity.".into()); }
    if !crate::user_connections::owns(executor_id) { return Err(SYNC_UNAVAILABLE.into()); }
    let mut arguments = vec!["sync".to_owned(), "--executor".to_owned(), executor_id.to_owned()];
    arguments.extend(tail.iter().map(|part| (*part).to_owned()));
    crate::user_runtime::run(&arguments, input)
}

/// `FolderSyncConsoleState` for one team: what the Sync tab draws and the tray's Sync line reads.
pub(crate) fn sync_status(executor_id: &str) -> Result<serde_json::Value, String> {
    sync_cli(executor_id, &["status", "--json"], None)
}

fn sync_send(executor_id: &str, command: &serde_json::Value) -> Result<serde_json::Value, String> {
    sync_cli(executor_id, &["--input-stdin", "--json"], Some(command))
}

/// The settings a console may change. Anything else, or any extra field, is refused here.
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
enum SyncChange {
    Configure {
        root: String,
        enabled: bool,
        #[serde(rename = "acceptExistingFiles")]
        accept_existing_files: bool,
    },
    Pause { paused: bool },
    HeldDeletes {
        #[serde(rename = "batchId")]
        batch_id: String,
        decision: HeldDecision,
    },
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum HeldDecision { Confirm, Restore }

fn sync_change(value: serde_json::Value) -> Result<serde_json::Value, String> {
    let change: SyncChange = serde_json::from_value(value).map_err(|_| SYNC_INVALID)?;
    let valid = match &change {
        SyncChange::Configure { root, .. } => !root.is_empty() && root.len() <= 4096 && !root.contains('\0'),
        SyncChange::Pause { .. } => true,
        SyncChange::HeldDeletes { batch_id, .. } => is_uuid(batch_id),
    };
    if !valid { return Err(SYNC_INVALID.into()); }
    serde_json::to_value(change).map_err(|_| SYNC_INVALID.into())
}

fn resolve_command(client_conflict_id: &str, resolution: &str) -> Result<serde_json::Value, String> {
    if !is_uuid(client_conflict_id) || !matches!(resolution, "keep_mine" | "keep_nessie" | "dismiss") {
        return Err(SYNC_INVALID.into());
    }
    Ok(serde_json::json!({ "command": "resolve", "clientConflictId": client_conflict_id, "resolution": resolution }))
}

fn restore_command(entry_id: &str) -> Result<serde_json::Value, String> {
    if entry_id.is_empty() || entry_id.len() > 4096 || entry_id.chars().any(char::is_control) {
        return Err(SYNC_INVALID.into());
    }
    Ok(serde_json::json!({ "command": "restore_trash", "entryId": entry_id }))
}

/// The steps from the sync root to a conflict's file: the team folder, then
/// the relative path's own segments. None may climb, name a drive or hide a
/// separator.
fn relative_segments<'a>(team_label: &'a str, rel_path: &'a str) -> Result<Vec<&'a str>, String> {
    let segments: Vec<&str> = std::iter::once(team_label).chain(rel_path.split('/')).collect();
    if segments.iter().any(|segment| segment.is_empty() || *segment == "." || *segment == ".."
        || segment.contains(['\\', ':', '\0'])) {
        return Err(SYNC_INVALID.into());
    }
    Ok(segments)
}

fn local_folder(state: &serde_json::Value, key: &str, missing: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::PathBuf::from(state[key].as_str().ok_or_else(|| missing.to_owned())?);
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| missing.to_owned())?;
    if !path.is_absolute() || metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(missing.to_owned());
    }
    Ok(path)
}

/// A file Show in folder may point at: one the CLI lists as an open conflict,
/// reached from the sync root without passing through a link.
fn listed_file(state: &serde_json::Value, rel_path: &str) -> Result<std::path::PathBuf, String> {
    let listed = state["conflicts"].as_array().is_some_and(|rows| {
        rows.iter().any(|row| row["relPath"].as_str() == Some(rel_path))
    });
    if !listed { return Err("That file is no longer listed.".into()); }
    let team = state["teamLabel"].as_str().ok_or("This team's folder is not ready yet.")?;
    let mut path = local_folder(state, "root", "The sync folder is missing. Choose it again.")?;
    for segment in relative_segments(team, rel_path)? {
        path.push(segment);
        let metadata = std::fs::symlink_metadata(&path).map_err(|_| "That file is no longer in the folder.")?;
        if metadata.file_type().is_symlink() { return Err("That file is behind a link, so it isn't shown.".into()); }
    }
    Ok(path)
}

fn open_location(
    app: &AppHandle, executor_id: &str, location: &str, rel_path: Option<&str>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let state = sync_status(executor_id)?;
    // A file is shown selected in Explorer, never opened: it may be a program.
    if location == "file" {
        let path = listed_file(&state, rel_path.ok_or(SYNC_INVALID)?)?;
        return app.opener().reveal_item_in_dir(path).map_err(|_| "Nessie Computer could not show that file.".into());
    }
    let folder = match location {
        "root" => local_folder(&state, "root", "The sync folder is missing. Choose it again.")?,
        "trash" => local_folder(&state, "trashPath", "Nothing has been deleted yet.")?,
        _ => return Err(SYNC_INVALID.into()),
    };
    app.opener().open_path(folder.display().to_string(), None::<&str>)
        .map_err(|_| "Nessie Computer could not open that folder.".into())
}

/// Opens this computer's Sync tab in Nessie at the address the CLI's handshake
/// recorded, over HTTPS only (a development build may use a local address).
fn open_manage(app: &AppHandle, executor_id: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let state = sync_status(executor_id)?;
    let address = state["manageUrl"].as_str().ok_or("Nessie has not answered this computer yet. Try again shortly.")?;
    let url = url::Url::parse(address).map_err(|_| "Nessie gave an address this app does not open.")?;
    let local = cfg!(debug_assertions) && url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1"));
    if !(url.scheme() == "https" || local) || !url.username().is_empty() || url.password().is_some() {
        return Err("Nessie gave an address this app does not open.".into());
    }
    app.opener().open_url(url.as_str(), None::<&str>).map_err(|_| "Nessie Computer could not open Nessie.".into())
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn executor_sync_pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    blocking(move || {
        let mut dialog = app.dialog().file().set_title("Choose the folder to keep in sync with Nessie");
        let documents = std::env::var_os("USERPROFILE").map(|home| std::path::PathBuf::from(home).join("Documents"));
        if let Some(documents) = documents.filter(|path| path.is_dir()) { dialog = dialog.set_directory(documents); }
        Ok(dialog.blocking_pick_folder().and_then(|path| path.into_path().ok()).map(|path| path.display().to_string()))
    }).await
}

#[tauri::command]
pub async fn executor_sync_status(executor_id: String) -> Result<serde_json::Value, String> {
    blocking(move || sync_status(&executor_id)).await
}

#[tauri::command]
pub async fn executor_sync_configure(
    executor_id: String, command: serde_json::Value,
) -> Result<serde_json::Value, String> {
    blocking(move || sync_send(&executor_id, &sync_change(command)?)).await
}

#[tauri::command]
pub async fn executor_sync_resolve(
    executor_id: String, client_conflict_id: String, resolution: String,
) -> Result<serde_json::Value, String> {
    blocking(move || sync_send(&executor_id, &resolve_command(&client_conflict_id, &resolution)?)).await
}

#[tauri::command]
pub async fn executor_sync_trash_list(executor_id: String) -> Result<serde_json::Value, String> {
    blocking(move || sync_cli(&executor_id, &["trash", "--json"], None)).await
}

#[tauri::command]
pub async fn executor_sync_trash_restore(executor_id: String, entry_id: String) -> Result<serde_json::Value, String> {
    blocking(move || sync_send(&executor_id, &restore_command(&entry_id)?)).await
}

#[tauri::command]
pub async fn executor_open_path(
    app: AppHandle, executor_id: String, location: String, rel_path: Option<String>,
) -> Result<(), String> {
    blocking(move || open_location(&app, &executor_id, &location, rel_path.as_deref())).await
}

#[tauri::command]
pub async fn executor_sync_open_nessie(app: AppHandle, executor_id: String) -> Result<(), String> {
    blocking(move || open_manage(&app, &executor_id)).await
}

#[cfg(test)]
mod sync_tests {
    use super::{relative_segments, resolve_command, restore_command, sync_change};
    use serde_json::json;

    #[test]
    fn a_sync_change_is_one_known_command_with_only_its_own_fields() {
        let configure = json!({"command":"configure","root":"C:\\Users\\person\\Documents\\Nessie","enabled":true,
            "acceptExistingFiles":false});
        assert_eq!(sync_change(configure.clone()).unwrap(), configure);
        assert_eq!(sync_change(json!({"command":"pause","paused":true})).unwrap(), json!({"command":"pause","paused":true}));
        let held = json!({"command":"held_deletes","batchId":"5a0e6b2c-8d7f-4e19-b3c2-6f1d9e4a7b10","decision":"restore"});
        assert_eq!(sync_change(held.clone()).unwrap(), held);
        assert!(sync_change(json!({"command":"pause","paused":true,"root":"C:\\elsewhere"})).is_err());
        assert!(sync_change(json!({"command":"configure","root":"","enabled":true,"acceptExistingFiles":false})).is_err());
        assert!(sync_change(json!({"command":"held_deletes","batchId":"latest","decision":"confirm"})).is_err());
        assert!(sync_change(json!({"command":"held_deletes","batchId":"5a0e6b2c-8d7f-4e19-b3c2-6f1d9e4a7b10",
            "decision":"purge"})).is_err());
        assert!(sync_change(json!({"command":"resolve","clientConflictId":"x","resolution":"keep_mine"})).is_err());
    }

    #[test]
    fn a_resolution_names_one_conflict_and_one_known_choice() {
        let id = "7d1c5d8e-2f4b-4c3a-9a51-0b6f0d2a1c01";
        assert_eq!(resolve_command(id, "keep_nessie").unwrap(),
            json!({"command":"resolve","clientConflictId":id,"resolution":"keep_nessie"}));
        assert!(resolve_command(id, "delete").is_err());
        assert!(resolve_command("../../etc", "dismiss").is_err());
        assert!(restore_command("2026-11-02/Product/Old plan.md").is_ok());
        assert!(restore_command("bad\nentry").is_err());
    }

    #[test]
    fn show_in_folder_never_climbs_out_of_the_team_folder() {
        assert_eq!(relative_segments("Platform", "Product/Plan.md").unwrap(), vec!["Platform", "Product", "Plan.md"]);
        for path in ["../secret.txt", "Product/../../x", "/abs", "C:/x", "a\\b", "a//b", "./x"] {
            assert!(relative_segments("Platform", path).is_err(), "{path}");
        }
        assert!(relative_segments("..", "x").is_err());
    }
}

#[cfg(windows)]
mod autostart {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
    use crate::registry;
    const KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const NAME: &str = "NessieExecutorTray";
    fn launch() -> Result<String, String> {
        Ok(format!("\"{}\"", std::env::current_exe().map_err(|e| e.to_string())?.display()))
    }
    pub fn enabled() -> Result<bool, String> {
        let value = registry::read_string(HKEY_CURRENT_USER, KEY, Some(NAME))
            .map_err(|_| "Could not read the Windows login setting.".to_owned())?;
        let launch = launch()?;
        Ok(value.is_some_and(|value| value == launch))
    }
    pub fn set(enabled: bool) -> Result<(), String> {
        let outcome = if enabled { registry::write_string(HKEY_CURRENT_USER, KEY, Some(NAME), &launch()?) }
            else { registry::delete_value(HKEY_CURRENT_USER, KEY, NAME) };
        outcome.map_err(|_| "Could not change the Windows login setting.".to_owned())
    }
}

#[cfg(not(windows))]
mod autostart {
    pub fn enabled() -> Result<bool, String> { Err("Windows only.".into()) }
    pub fn set(_: bool) -> Result<(), String> { Err("Windows only.".into()) }
}
