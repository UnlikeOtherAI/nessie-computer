//! The owner's own controls over a team this service runs: Pause and Resume,
//! program requests, and "Who can send work here".
//!
//! Each is the packaged CLI's own verb against the team's state directory, so
//! the daemon is told through the same path a person at a terminal uses. A
//! pause is a record in that directory: it survives this service restarting,
//! the person signing out and an update, and the daemon enforces it.
//!
//! Program requests can be read and answered only by the account that paired
//! the team. Every admitted account may pause or resume, as it may start and
//! stop; only the owner decides what an agent may run.

use std::{fs, path::Path, time::Instant};

use nessie_windows_common::owner_controls::{
    answer_arguments, audience_arguments, parse_program_requests, pause_arguments,
    program_requests_arguments, Answer, ProgramRequest,
};

use crate::{
    paths::{has_executor_state, PAIRED_BY_FILE},
    supervisor::Supervisor,
};

const NOT_OWNER: &str = "Only the person who connected this team can answer its requests.";

impl Supervisor {
    fn paired_state_dir(&self, executor_id: &str) -> Result<std::path::PathBuf, String> {
        let state_dir = self.state_dir(executor_id)?;
        if !has_executor_state(&state_dir) {
            return Err("This executor has not been paired on this computer.".to_owned());
        }
        Ok(state_dir)
    }

    fn require_owner(state_dir: &Path, sid: Option<&str>) -> Result<(), String> {
        let owner = fs::read_to_string(state_dir.join(PAIRED_BY_FILE)).map_err(|_| NOT_OWNER.to_owned())?;
        match sid {
            Some(sid) if sid == owner.trim() => Ok(()),
            _ => Err(NOT_OWNER.to_owned()),
        }
    }

    /// Pauses or resumes one team. Its daemon keeps running and keeps its
    /// connection; it refuses new work while paused.
    pub fn set_paused(&mut self, executor_id: &str, paused: bool) -> Result<(), String> {
        let state_dir = self.paired_state_dir(executor_id)?;
        self.run_to_completion(
            pause_arguments(&state_dir, paused),
            if paused {
                "Nessie Computer couldn’t pause this team. Try again."
            } else {
                "Nessie Computer couldn’t resume this team. Try again."
            },
        )
    }

    fn read_program_requests(&self, state_dir: &Path) -> Result<Vec<ProgramRequest>, String> {
        let (status, output) = self.public_json_command(program_requests_arguments(state_dir), None)?;
        if status != 0 {
            return Err("The program requests could not be read.".to_owned());
        }
        parse_program_requests(
            serde_json::from_str(&output).map_err(|_| "The program requests could not be read.".to_owned())?,
        )
    }

    /// How many requests wait for this team's owner. Read through the CLI only
    /// when the requests directory changed, so a status poll costs a `stat`.
    pub(crate) fn pending_program_requests(&mut self, executor_id: &str, state_dir: &Path) -> usize {
        let mut cache = self.program_requests.remove(executor_id).unwrap_or_default();
        cache.refresh(state_dir, Instant::now(), || self.read_program_requests(state_dir));
        let pending = cache.requests().len();
        self.program_requests.insert(executor_id.to_owned(), cache);
        pending
    }

    pub fn program_requests(&mut self, executor_id: &str, sid: Option<&str>) -> Result<Vec<ProgramRequest>, String> {
        let state_dir = self.paired_state_dir(executor_id)?;
        Self::require_owner(&state_dir, sid)?;
        let requests = self.read_program_requests(&state_dir)?;
        self.program_requests.entry(executor_id.to_owned()).or_default().replace(requests.clone(), Instant::now());
        Ok(requests)
    }

    /// Answers one request and answers with the list that remains.
    pub fn answer_program_request(
        &mut self,
        executor_id: &str,
        id: &str,
        answer: Answer,
        sid: Option<&str>,
    ) -> Result<Vec<ProgramRequest>, String> {
        let state_dir = self.paired_state_dir(executor_id)?;
        Self::require_owner(&state_dir, sid)?;
        self.run_to_completion(
            answer_arguments(&state_dir, id, answer)?,
            "That request has already been answered or has expired.",
        )?;
        self.program_requests(executor_id, sid)
    }

    /// Who may send work to this team here, as Nessie answers the signed
    /// request. Nothing of it is kept.
    pub fn audience(&mut self, executor_id: &str) -> Result<serde_json::Value, String> {
        let state_dir = self.paired_state_dir(executor_id)?;
        let (status, output) = self.public_json_command(audience_arguments(&state_dir), None)?;
        if status != 0 {
            return Err("Nessie didn’t say who can send work here. Check your connection and try again.".to_owned());
        }
        serde_json::from_str(&output).map_err(|_| "Nessie’s answer could not be read.".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::{Supervisor, NOT_OWNER};
    use crate::{manifest::VerifiedRuntime, paths::PAIRED_BY_FILE};

    const TEAM: &str = "00000000-0000-4000-8000-000000000001";

    fn supervisor(root: &std::path::Path) -> Supervisor {
        Supervisor::new(root.to_owned(), VerifiedRuntime {
            root: root.to_owned(),
            node_executable: root.join("nessie-executor-runtime.exe"),
            native_helper: root.join("nessie-executor-native.exe"),
        })
    }

    fn paired(host: &Supervisor, owner: Option<&str>) {
        let directory = host.state_dir(TEAM).unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("executor-state.json"), "{}").unwrap();
        if let Some(owner) = owner {
            std::fs::write(directory.join(PAIRED_BY_FILE), format!("{owner}\n")).unwrap();
        }
    }

    #[test]
    fn only_the_account_that_connected_the_team_reads_or_answers_its_requests() {
        let root = tempfile::tempdir().unwrap();
        let mut host = supervisor(root.path());
        paired(&host, Some("S-1-5-21-1"));
        for sid in [None, Some("S-1-5-21-2")] {
            assert_eq!(host.program_requests(TEAM, sid), Err(NOT_OWNER.to_owned()));
            assert_eq!(
                host.answer_program_request(TEAM, "r-1", nessie_windows_common::owner_controls::Answer::Once, sid),
                Err(NOT_OWNER.to_owned()),
            );
        }
        let root = tempfile::tempdir().unwrap();
        let mut unowned = supervisor(root.path());
        paired(&unowned, None);
        assert_eq!(unowned.program_requests(TEAM, Some("S-1-5-21-1")), Err(NOT_OWNER.to_owned()));
    }

    #[test]
    fn an_unpaired_team_is_refused_before_anything_runs() {
        let root = tempfile::tempdir().unwrap();
        let mut host = supervisor(root.path());
        let refusal = Err("This executor has not been paired on this computer.".to_owned());
        assert_eq!(host.set_paused(TEAM, true), refusal);
        assert_eq!(host.audience(TEAM).map(|_| ()), refusal);
        assert_eq!(host.program_requests(TEAM, Some("S-1-5-21-1")).map(|_| ()), refusal);
    }

    #[test]
    fn a_team_that_never_asked_has_no_pending_requests_and_runs_nothing() {
        let root = tempfile::tempdir().unwrap();
        let mut host = supervisor(root.path());
        paired(&host, Some("S-1-5-21-1"));
        let state_dir = host.state_dir(TEAM).unwrap();
        // No program-requests directory: the count is read without a process.
        assert_eq!(host.pending_program_requests(TEAM, &state_dir), 0);
        let statuses = host.statuses();
        assert_eq!(statuses.len(), 1);
        assert!(!statuses[0].paused);
        std::fs::write(state_dir.join("owner-pause.json"), r#"{"paused":true,"since":"2026-11-08T09:00:00Z"}"#)
            .unwrap();
        assert!(host.statuses()[0].paused);
    }
}
