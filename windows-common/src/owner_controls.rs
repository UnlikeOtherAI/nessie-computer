//! The owner's own controls over one team on this computer: Pause and Resume,
//! program requests, and "Who can send work here".
//!
//! Both Windows supervisors carry them out the same way, through the packaged
//! CLI: the tray for the teams it runs under the person's account, the service
//! for its own. So the argv, the one file both read for status, and the
//! answer shapes are stated once, here, and tested on any host.
//!
//! Writes always go through the CLI, which notifies the running daemon. Status
//! reads `owner-pause.json` directly: it is a non-secret `{ "paused", "since" }`
//! record the contract defines, and reading it costs no process per poll.

use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

use serde::{Deserialize, Serialize};

/// The record `pause` and `resume` write in a team's state directory.
pub const OWNER_PAUSE_FILE: &str = "owner-pause.json";

/// The directory a daemon holds its pending program requests in.
pub const PROGRAM_REQUESTS_DIRECTORY: &str = "program-requests";

/// How often a list that still has requests in it is read again, so a request
/// that expired without a directory change still leaves the count.
const PENDING_REREAD: Duration = Duration::from_secs(15);

/// `pause --state-dir <dir>` or `resume --state-dir <dir>`.
pub fn pause_arguments(state_dir: &Path, paused: bool) -> Vec<String> {
    vec![
        if paused { "pause" } else { "resume" }.to_owned(),
        "--state-dir".to_owned(),
        state_dir.display().to_string(),
    ]
}

/// Whether the owner paused this team. A missing record is not paused; a
/// record this reader cannot parse is reported as not paused too, because the
/// daemon — not this status line — is what enforces a pause.
pub fn read_paused(state_dir: &Path) -> bool {
    #[derive(Deserialize)]
    struct Record {
        paused: bool,
    }
    std::fs::read(state_dir.join(OWNER_PAUSE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Record>(&bytes).ok())
        .is_some_and(|record| record.paused)
}

pub fn program_requests_arguments(state_dir: &Path) -> Vec<String> {
    vec![
        "program-requests".to_owned(),
        "--state-dir".to_owned(),
        state_dir.display().to_string(),
        "--json".to_owned(),
    ]
}

/// The owner's three answers, in the CLI's words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Answer {
    Once,
    Always,
    Deny,
}

impl Answer {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "once" => Ok(Self::Once),
            "always" => Ok(Self::Always),
            "deny" => Ok(Self::Deny),
            _ => Err("Choose Allow once, Always allow or Don't allow.".to_owned()),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Always => "always",
            Self::Deny => "deny",
        }
    }
}

/// A request id becomes a CLI argument, so it is held to the identifier rule
/// before it gets there.
pub fn valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub fn answer_arguments(state_dir: &Path, id: &str, answer: Answer) -> Result<Vec<String>, String> {
    if !valid_request_id(id) {
        return Err("That request is no longer listed.".to_owned());
    }
    Ok(vec![
        "program-request".to_owned(),
        "answer".to_owned(),
        "--state-dir".to_owned(),
        state_dir.display().to_string(),
        "--id".to_owned(),
        id.to_owned(),
        "--answer".to_owned(),
        answer.as_str().to_owned(),
    ])
}

pub fn audience_arguments(state_dir: &Path) -> Vec<String> {
    vec![
        "audience".to_owned(),
        "--state-dir".to_owned(),
        state_dir.display().to_string(),
        "--json".to_owned(),
    ]
}

/// One pending request, as `program-requests --json` lists it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramRequest {
    pub id: String,
    pub program: String,
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    pub requested_at: String,
    pub expires_at: String,
}

/// The CLI's list, or a refusal: an answer this reader does not recognise is
/// never an empty list, which would hide a request that is waiting.
pub fn parse_program_requests(value: serde_json::Value) -> Result<Vec<ProgramRequest>, String> {
    serde_json::from_value(value).map_err(|_| "The program request list could not be read.".to_owned())
}

/// The last list read for one team, re-read only when its directory changes,
/// or every few seconds while it still holds requests. A directory's modified
/// time changes whenever a request is added or removed, so the poll costs a
/// `stat` rather than a process.
#[derive(Debug, Default)]
pub struct RequestCache {
    modified: Option<SystemTime>,
    read_at: Option<Instant>,
    requests: Vec<ProgramRequest>,
}

fn requests_directory(state_dir: &Path) -> PathBuf {
    state_dir.join(PROGRAM_REQUESTS_DIRECTORY)
}

impl RequestCache {
    pub fn requests(&self) -> &[ProgramRequest] {
        &self.requests
    }

    /// Reads the list again when it may have changed. `read` runs the CLI; a
    /// failed read keeps the last list and is tried again on the next poll.
    pub fn refresh(
        &mut self,
        state_dir: &Path,
        now: Instant,
        read: impl FnOnce() -> Result<Vec<ProgramRequest>, String>,
    ) {
        let modified = std::fs::metadata(requests_directory(state_dir))
            .and_then(|metadata| metadata.modified())
            .ok();
        if modified.is_none() && self.requests.is_empty() {
            // No directory: the daemon has never asked, and there is nothing to read.
            self.modified = None;
            return;
        }
        let stale = self.read_at.is_none_or(|read_at| {
            !self.requests.is_empty() && now.duration_since(read_at) >= PENDING_REREAD
        });
        if modified == self.modified && !stale {
            return;
        }
        if let Ok(requests) = read() {
            self.requests = requests;
            self.modified = modified;
            self.read_at = Some(now);
        }
    }

    /// Replaces the list with one just read for an answer, so the count moves
    /// in the same round trip.
    pub fn replace(&mut self, requests: Vec<ProgramRequest>, now: Instant) {
        self.requests = requests;
        self.read_at = Some(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pause_and_resume_name_the_state_directory_and_nothing_else() {
        let dir = Path::new(r"C:\Users\person\.local\state\nessie-executor\team");
        assert_eq!(pause_arguments(dir, true), ["pause", "--state-dir", &dir.display().to_string()]);
        assert_eq!(pause_arguments(dir, false)[0], "resume");
    }

    #[test]
    fn a_pause_is_read_from_its_record_and_absent_means_working() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!read_paused(dir.path()));
        std::fs::write(dir.path().join(OWNER_PAUSE_FILE), r#"{"paused":true,"since":"2026-11-08T10:00:00.000Z"}"#)
            .unwrap();
        assert!(read_paused(dir.path()));
        std::fs::write(dir.path().join(OWNER_PAUSE_FILE), r#"{"paused":false,"since":"2026-11-08T10:00:00.000Z"}"#)
            .unwrap();
        assert!(!read_paused(dir.path()));
        std::fs::write(dir.path().join(OWNER_PAUSE_FILE), "not json").unwrap();
        assert!(!read_paused(dir.path()));
    }

    #[test]
    fn an_answer_is_one_of_three_words_for_one_listed_id() {
        let dir = Path::new("/state");
        assert_eq!(
            answer_arguments(dir, "4f1c2d3e-0000-4000-8000-000000000001", Answer::parse("always").unwrap()).unwrap(),
            ["program-request", "answer", "--state-dir", "/state", "--id",
                "4f1c2d3e-0000-4000-8000-000000000001", "--answer", "always"],
        );
        for answer in ["", "allow", "ALWAYS", "deny "] {
            assert!(Answer::parse(answer).is_err(), "{answer:?}");
        }
        for id in ["", "../x", "a b", "id;rm", &"x".repeat(129)] {
            assert!(answer_arguments(dir, id, Answer::Once).is_err(), "{id:?}");
        }
    }

    #[test]
    fn a_request_list_is_read_strictly_enough_to_never_look_empty() {
        let list = parse_program_requests(serde_json::json!([{
            "id": "r1", "program": "python", "args": ["build.py"], "agentName": "Builder",
            "requestedAt": "2026-11-08T10:00:00.000Z", "expiresAt": "2026-11-08T10:02:00.000Z",
        }])).unwrap();
        assert_eq!(list[0].agent_name.as_deref(), Some("Builder"));
        assert!(parse_program_requests(serde_json::json!({"requests": []})).is_err());
        assert!(parse_program_requests(serde_json::json!([{"id": "r1"}])).is_err());
    }

    fn request(id: &str) -> ProgramRequest {
        ProgramRequest {
            id: id.to_owned(), program: "python".to_owned(), args: Vec::new(), agent_name: None,
            requested_at: "2026-11-08T10:00:00.000Z".to_owned(), expires_at: "2026-11-08T10:02:00.000Z".to_owned(),
        }
    }

    #[test]
    fn the_list_is_read_only_when_its_directory_changes_or_requests_may_have_expired() {
        let dir = tempfile::tempdir().unwrap();
        let mut cache = RequestCache::default();
        let start = Instant::now();
        cache.refresh(dir.path(), start, || panic!("no directory means nothing to read"));
        std::fs::create_dir(dir.path().join(PROGRAM_REQUESTS_DIRECTORY)).unwrap();
        cache.refresh(dir.path(), start, || Ok(vec![request("r1")]));
        assert_eq!(cache.requests().len(), 1);
        cache.refresh(dir.path(), start + Duration::from_secs(3), || panic!("unchanged and recent"));
        cache.refresh(dir.path(), start + PENDING_REREAD, || Ok(Vec::new()));
        assert!(cache.requests().is_empty());
        cache.refresh(dir.path(), start + PENDING_REREAD * 3, || panic!("empty and unchanged"));
        // A failed read keeps what was last known rather than hiding a request.
        cache.replace(vec![request("r2")], start);
        cache.refresh(dir.path(), start + PENDING_REREAD, || Err("busy".to_owned()));
        assert_eq!(cache.requests()[0].id, "r2");
    }
}
