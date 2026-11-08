//! Claude Code and Codex on this computer (contract §12): the AI tab's
//! **On this computer** rows and their Make available switches, through the
//! CLI's `local-inference engines` plumbing verb. Only a team connected under
//! this Windows account can use the owner's own CLI sign-in; a team the
//! background service runs answers `{ "unavailable": "service" }`.
use serde_json::{json, Value};

const ENGINES: [&str; 2] = ["claude-code", "codex"];

fn engine(value: &str) -> Result<&str, String> {
    ENGINES.iter().copied().find(|known| *known == value).ok_or_else(|| "Choose Claude Code or Codex.".into())
}

fn profile(value: &str) -> Result<&str, String> {
    if value.len() == 36 && value.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') { Ok(value) }
    else { Err("That account is not on this computer.".into()) }
}

async fn operation(executor_id: String, operation: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !crate::user_connections::owns(&executor_id) { return Ok(json!({ "unavailable": "service" })); }
        let state_dir = crate::user_connections::directory(&executor_id)?.display().to_string();
        crate::user_runtime::run(&["local-inference".into(), "engines".into(), "--operation-stdin".into(),
            "--state-dir".into(), state_dir], Some(&operation))
    }).await.map_err(|_| "Could not check Claude Code and Codex on this computer.".to_string())?
}

#[tauri::command]
pub async fn executor_local_ai(executor_id: String) -> Result<Value, String> {
    operation(executor_id, json!({ "operation": "list" })).await
}

#[tauri::command]
pub async fn executor_set_local_ai(executor_id: String, engine: String, profile_id: Option<String>, available: bool)
    -> Result<Value, String> {
    let profile_id = profile_id.as_deref().map(profile).transpose()?;
    operation(executor_id, json!({ "operation": "set", "engine": self::engine(&engine)?, "profileId": profile_id,
        "available": available })).await
}

#[tauri::command]
pub async fn executor_local_ai_add_account(executor_id: String, engine: String, name: String) -> Result<Value, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 { return Err("Give the account a name of up to 80 characters.".into()); }
    operation(executor_id, json!({ "operation": "add", "engine": self::engine(&engine)?, "name": name })).await
}

#[tauri::command]
pub async fn executor_local_ai_sign_in(executor_id: String, profile_id: String) -> Result<Value, String> {
    operation(executor_id, json!({ "operation": "sign-in", "profileId": profile(&profile_id)? })).await
}

#[tauri::command]
pub async fn executor_local_ai_remove_account(executor_id: String, profile_id: String) -> Result<Value, String> {
    operation(executor_id, json!({ "operation": "remove", "profileId": profile(&profile_id)? })).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_known_engines_and_account_ids_pass() {
        assert_eq!(super::engine("codex"), Ok("codex"));
        assert!(super::engine("claude").is_err());
        assert!(super::profile("00000000-0000-4000-8000-000000000001").is_ok());
        assert!(super::profile("../other").is_err());
    }
}
