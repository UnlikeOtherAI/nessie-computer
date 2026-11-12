//! A team's saved name, as both Windows supervisors read it.
//!
//! The CLI keeps each team's display-only label in its state folder as
//! `team-label.json` (`src/team-label.ts`, `docs/team-names.md`): written when
//! the team connects and whenever Nessie names it again through the batched
//! `team-names` verb, never blanked by a read that fails. It is not secret, so
//! status reads it directly, the way it reads `owner-pause.json`, and costs no
//! process per poll. It labels a line; it never grants anything.

use std::{
    io::Read,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

/// The record's file name in a team's state directory.
pub const TEAM_LABEL_FILE: &str = "team-label.json";

/// How often a supervisor asks Nessie for its teams' names again.
pub const TEAM_NAMES_REFRESH_SECONDS: u64 = 60 * 60;

/// The longest name a label shows, as the CLI holds it.
const NAME_LIMIT: usize = 160;

/// What a team is called and which server said so. `team_name` is `None` for
/// a team connected for its whole organisation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamLabel {
    pub organization_name: String,
    pub team_name: Option<String>,
    pub api_base_url: String,
}

fn display_name(value: Option<String>) -> Option<String> {
    let trimmed = value?.trim().to_owned();
    (!trimmed.is_empty() && trimmed.chars().count() <= NAME_LIMIT).then_some(trimmed)
}

/// The team's saved label; `None` when it has never had one or the record is
/// not one this reader accepts — the same answer the CLI gives.
pub fn read_team_label(state_dir: &Path) -> Option<TeamLabel> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Record {
        organization_name: Option<String>,
        team_name: Option<String>,
        api_base_url: Option<String>,
    }
    let record: Record = serde_json::from_slice(&std::fs::read(state_dir.join(TEAM_LABEL_FILE)).ok()?).ok()?;
    Some(TeamLabel {
        organization_name: display_name(record.organization_name)?,
        team_name: display_name(record.team_name),
        api_base_url: record.api_base_url.filter(|url| !url.is_empty())?,
    })
}

/// `team-names --state-dir <dir> … --json`: one call that names every listed
/// team, one request per Nessie server. `None` when there is nothing to name.
pub fn team_names_arguments(state_dirs: &[PathBuf]) -> Option<Vec<String>> {
    if state_dirs.is_empty() {
        return None;
    }
    let mut arguments = vec!["team-names".to_owned()];
    for state_dir in state_dirs {
        arguments.push("--state-dir".to_owned());
        arguments.push(state_dir.display().to_string());
    }
    arguments.push("--json".to_owned());
    Some(arguments)
}

/// What every line a refresh's failures print starts with (`src/team-names.ts`).
const FAILURE_PREFIX: &str = "[nessie-executor] team names:";
const FAILURE_LINES: usize = 64;
const FAILURE_LINE_CHARS: usize = 400;

/// The failures a `team-names` call printed on standard error, one line each,
/// for the supervisor's own log. They name a server, a team id and Nessie's
/// status and code only; anything else on the stream is not carried over.
pub fn team_names_failures(standard_error: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(standard_error)
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with(FAILURE_PREFIX))
        .take(FAILURE_LINES)
        .map(|line| line["[nessie-executor] ".len()..].chars().take(FAILURE_LINE_CHARS).collect())
        .collect()
}

/// Reads a `team-names` call's standard error to its end on a thread of its
/// own, so the child never blocks on a full pipe, and answers its failures.
pub fn collect_team_names_failures(mut stream: impl Read + Send + 'static) -> std::thread::JoinHandle<Vec<String>> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = (&mut stream).take(1 << 20).read_to_end(&mut bytes);
        let _ = std::io::copy(&mut stream, &mut std::io::sink());
        team_names_failures(&bytes)
    })
}

#[cfg(test)]
mod tests {
    use super::{read_team_label, team_names_arguments, team_names_failures, TeamLabel, TEAM_LABEL_FILE};

    #[test]
    fn a_refresh_failure_line_is_kept_and_nothing_else_on_the_stream() {
        let printed = b"[nessie-executor] team names: api.nessie.works did not answer the batched read (HTTP 401 AUTH_REQUIRED); asking each team.\r\n\
            (node:1) Warning: something else\n\
            [nessie-executor] heartbeat failed: x\n\
            [nessie-executor] team names: api.nessie.works did not name team 48d72fea (HTTP 401 UOA_SESSION_REQUIRED).\n";
        assert_eq!(team_names_failures(printed), [
            "team names: api.nessie.works did not answer the batched read (HTTP 401 AUTH_REQUIRED); asking each team.",
            "team names: api.nessie.works did not name team 48d72fea (HTTP 401 UOA_SESSION_REQUIRED).",
        ]);
        assert!(team_names_failures(b"").is_empty());
        let long = format!("[nessie-executor] team names: {}\n", "x".repeat(1000)).repeat(100);
        let kept = team_names_failures(long.as_bytes());
        assert_eq!(kept.len(), 64);
        assert!(kept.iter().all(|line| line.chars().count() == 400));
    }

    #[test]
    fn a_saved_label_reads_back_and_anything_else_is_no_name() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(read_team_label(directory.path()), None, "a team that never had a name");
        let path = directory.path().join(TEAM_LABEL_FILE);
        std::fs::write(&path, r#"{"organizationName":" Acme ","teamName":"Sales","apiBaseUrl":"https://api.nessie.works","checkedAt":"2026-11-08T12:00:00.000Z"}"#).unwrap();
        assert_eq!(read_team_label(directory.path()), Some(TeamLabel {
            organization_name: "Acme".to_owned(), team_name: Some("Sales".to_owned()),
            api_base_url: "https://api.nessie.works".to_owned(),
        }));
        std::fs::write(&path, r#"{"organizationName":"Acme","teamName":null,"apiBaseUrl":"https://x.example"}"#).unwrap();
        assert_eq!(read_team_label(directory.path()).unwrap().team_name, None);
        for damaged in [r#"{"organizationName":"  ","teamName":"Sales","apiBaseUrl":"https://x.example"}"#,
            r#"{"teamName":"Sales","apiBaseUrl":"https://x.example"}"#, r#"{"organizationName":"Acme"}"#, "not json"] {
            std::fs::write(&path, damaged).unwrap();
            assert_eq!(read_team_label(directory.path()), None, "{damaged}");
        }
    }

    #[test]
    fn one_call_names_every_team_and_nothing_is_asked_for_none() {
        assert_eq!(team_names_arguments(&[]), None);
        let dirs = [std::path::PathBuf::from("C:\\a"), std::path::PathBuf::from("C:\\b")];
        assert_eq!(team_names_arguments(&dirs).unwrap(),
            ["team-names", "--state-dir", "C:\\a", "--state-dir", "C:\\b", "--json"]);
    }
}
