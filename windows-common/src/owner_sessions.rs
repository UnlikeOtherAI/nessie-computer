//! The sessions agents are working in on this computer, for the owner's Now
//! working list (contract §11.5, `docs/sessions-and-concurrency.md`).
//!
//! Like the other owner controls, both Windows supervisors run the packaged
//! CLI's own verbs — `sessions` and `session stop` — against a team's state
//! directory: the tray for the teams it runs under the person's account, the
//! service for its own. The argv and the answer check are stated once, here.
//! A list is passed through as the CLI printed it; the console words it.

use std::{
    path::Path,
    time::{Duration, Instant, SystemTime},
};

/// The list the running daemon keeps in a team's state directory.
pub const SESSIONS_FILE: &str = "sessions.json";

/// How long a list that still names work is trusted without a change to its
/// file: a daemon that stopped without removing it is noticed by the CLI's
/// own liveness check on the next read.
const WORKING_REREAD: Duration = Duration::from_secs(30);

/// `sessions --state-dir <dir> --json`.
pub fn sessions_arguments(state_dir: &Path) -> Vec<String> {
    vec![
        "sessions".to_owned(),
        "--state-dir".to_owned(),
        state_dir.display().to_string(),
        "--json".to_owned(),
    ]
}

/// A session id names a file in the state directory, so only a UUID passes.
pub fn valid_session_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// `session stop --state-dir <dir> --id <sessionId> --json`.
pub fn stop_session_arguments(state_dir: &Path, id: &str) -> Result<Vec<String>, String> {
    if !valid_session_id(id) {
        return Err("That session is no longer working on this computer.".to_owned());
    }
    Ok(vec![
        "session".to_owned(),
        "stop".to_owned(),
        "--state-dir".to_owned(),
        state_dir.display().to_string(),
        "--id".to_owned(),
        id.to_owned(),
        "--json".to_owned(),
    ])
}

/// The CLI's list, or a refusal: anything but a list of sessions — each with
/// a UUID and a list of commands — is never shown as no sessions.
pub fn parse_sessions(value: serde_json::Value) -> Result<Vec<serde_json::Value>, String> {
    const UNREADABLE: &str = "The list of what agents are doing could not be read.";
    let serde_json::Value::Array(sessions) = value else { return Err(UNREADABLE.to_owned()) };
    for session in &sessions {
        let id = session.get("sessionId").and_then(serde_json::Value::as_str);
        if !id.is_some_and(valid_session_id) || !session.get("commands").is_some_and(serde_json::Value::is_array) {
            return Err(UNREADABLE.to_owned());
        }
    }
    Ok(sessions)
}

/// One team's sessions with its id on each, as the console lists them.
pub fn with_executor_id(executor_id: &str, sessions: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    sessions.into_iter().map(|mut session| {
        if let Some(object) = session.as_object_mut() {
            object.insert("executorId".to_owned(), serde_json::Value::String(executor_id.to_owned()));
        }
        session
    }).collect()
}

/// The last list read for one team, read again through the CLI only when the
/// daemon rewrote its file, or every half minute while it still names work.
/// The console asks every few seconds; a `stat` answers most of them.
#[derive(Debug, Default)]
pub struct SessionsCache {
    modified: Option<SystemTime>,
    read_at: Option<Instant>,
    sessions: Vec<serde_json::Value>,
}

impl SessionsCache {
    pub fn refresh(
        &mut self,
        state_dir: &Path,
        now: Instant,
        read: impl FnOnce() -> Result<Vec<serde_json::Value>, String>,
    ) -> Result<Vec<serde_json::Value>, String> {
        let modified = std::fs::metadata(state_dir.join(SESSIONS_FILE)).and_then(|metadata| metadata.modified()).ok();
        if modified.is_none() {
            // No list: no daemon is running for this team, so nothing works here.
            *self = Self::default();
            return Ok(Vec::new());
        }
        let stale = self.read_at.is_none_or(|read_at| {
            !self.sessions.is_empty() && now.duration_since(read_at) >= WORKING_REREAD
        });
        if modified != self.modified || stale {
            self.sessions = read()?;
            self.modified = modified;
            self.read_at = Some(now);
        }
        Ok(self.sessions.clone())
    }

    /// After a Stop the next read goes to the CLI whatever the file says.
    pub fn forget(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "0b0c3a40-6f1e-4f7e-9d3b-2d1b8f1e4c11";

    #[test]
    fn the_verbs_name_the_state_directory_and_one_session_uuid() {
        let dir = Path::new("/state");
        assert_eq!(sessions_arguments(dir), ["sessions", "--state-dir", "/state", "--json"]);
        assert_eq!(
            stop_session_arguments(dir, SESSION).unwrap(),
            ["session", "stop", "--state-dir", "/state", "--id", SESSION, "--json"],
        );
        for id in ["", "../x", "--json", "0b0c3a40-6f1e-4f7e-9d3b-2d1b8f1e4c1", "0b0c3a40x6f1e-4f7e-9d3b-2d1b8f1e4c11"] {
            assert!(stop_session_arguments(dir, id).is_err(), "{id:?}");
        }
    }

    #[test]
    fn the_list_is_read_again_only_when_its_file_changes_or_it_may_be_stale() {
        let dir = tempfile::tempdir().unwrap();
        let mut cache = SessionsCache::default();
        let start = Instant::now();
        let working = vec![serde_json::json!({ "sessionId": SESSION, "commands": [] })];
        assert!(cache.refresh(dir.path(), start, || panic!("no list means no daemon")).unwrap().is_empty());
        std::fs::write(dir.path().join(SESSIONS_FILE), "{}").unwrap();
        assert_eq!(cache.refresh(dir.path(), start, || Ok(working.clone())).unwrap(), working);
        assert_eq!(cache.refresh(dir.path(), start + Duration::from_secs(3), || panic!("unchanged")).unwrap(), working);
        assert!(cache.refresh(dir.path(), start + WORKING_REREAD, || Ok(Vec::new())).unwrap().is_empty());
        assert!(cache.refresh(dir.path(), start + WORKING_REREAD * 3, || panic!("empty, unchanged")).unwrap().is_empty());
        cache.forget();
        assert!(cache.refresh(dir.path(), start, || Err("busy".to_owned())).is_err());
        std::fs::remove_file(dir.path().join(SESSIONS_FILE)).unwrap();
        assert!(cache.refresh(dir.path(), start, || panic!("the daemon is gone")).unwrap().is_empty());
    }

    #[test]
    fn a_session_list_is_read_strictly_and_carries_its_team() {
        let list = parse_sessions(serde_json::json!([{
            "sessionId": SESSION, "agentName": "Sales agent", "startedAt": "2026-11-08T12:00:00.000Z",
            "commands": [{ "id": "c", "kind": "program", "status": "running", "program": "npm", "args": ["test"] }],
        }])).unwrap();
        let rows = with_executor_id("team-1", list);
        assert_eq!(rows[0]["executorId"], "team-1");
        assert_eq!(rows[0]["commands"][0]["program"], "npm");
        assert!(parse_sessions(serde_json::json!([])).unwrap().is_empty());
        assert!(parse_sessions(serde_json::json!({ "error": { "code": "X" } })).is_err());
        assert!(parse_sessions(serde_json::json!([{ "sessionId": "../x", "commands": [] }])).is_err());
        assert!(parse_sessions(serde_json::json!([{ "sessionId": SESSION }])).is_err());
    }
}
