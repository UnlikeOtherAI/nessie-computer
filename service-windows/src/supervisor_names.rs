//! The service's half of team names (`docs/team-names.md`): when it starts and
//! every hour, one packaged `team-names` call for every team it holds, which
//! asks Nessie once per server and saves each team's label in its folder.
//! Status rows then carry that label (`team_label::read_team_label`). The call
//! runs off the supervisor's lock, so a slow Nessie holds up no pipe request,
//! and a failed one leaves every saved name as it was.

use std::{path::PathBuf, process::Command, time::Duration};

use nessie_windows_common::team_label::team_names_arguments;

use crate::{
    paths::paired_executors,
    supervisor::{wait_bounded, Supervisor},
};

/// How long one naming call may run before it is stopped. Nessie's own
/// deadline is fifteen seconds a server, so this only ends a hung process.
const TEAM_NAMES_TIMEOUT: Duration = Duration::from_secs(60);

impl Supervisor {
    /// The one call that names every team this service holds; `None` when it holds none.
    pub fn team_names_command(&self) -> Option<Command> {
        let state_dirs: Vec<PathBuf> = paired_executors(&self.root).into_iter()
            .filter_map(|executor_id| self.state_dir(&executor_id).ok())
            .collect();
        let arguments = team_names_arguments(&state_dirs)?;
        let mut command = self.command();
        command.args(arguments);
        Some(command)
    }
}

/// Runs a naming call to its end, stopping it if it overruns.
pub fn run_team_names(mut command: Command) -> Result<(), String> {
    let mut child = command.spawn().map_err(|_| "Team names could not be read: the command did not start.".to_owned())?;
    match wait_bounded(&mut child, TEAM_NAMES_TIMEOUT) {
        Ok(Some(0)) => Ok(()),
        Ok(Some(code)) => Err(format!("Team names could not be read (exit {code}).")),
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            Err("Team names took too long and were stopped.".to_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{manifest::VerifiedRuntime, paths::executors_root};

    fn supervisor(root: &std::path::Path) -> Supervisor {
        Supervisor::new(root.to_owned(), VerifiedRuntime {
            root: root.to_owned(),
            node_executable: root.join("nessie-executor-runtime.exe"),
            native_helper: root.join("nessie-executor-native.exe"),
        })
    }

    #[test]
    fn one_call_names_every_paired_team_and_none_is_made_for_no_team() {
        let root = tempfile::tempdir().unwrap();
        let host = supervisor(root.path());
        assert!(host.team_names_command().is_none(), "nothing to name, nothing is asked");
        for id in ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2"] {
            let dir = executors_root(root.path()).join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("executor-state.json"), "{}").unwrap();
        }
        // A folder still pairing has no state yet and is not named.
        std::fs::create_dir_all(executors_root(root.path()).join("00000000-0000-4000-8000-0000000000a3")).unwrap();
        let command = host.team_names_command().unwrap();
        let arguments: Vec<String> = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        let at = arguments.iter().position(|arg| arg == "team-names").unwrap();
        assert_eq!(arguments[at..].iter().filter(|arg| *arg == "--state-dir").count(), 2);
        assert!(arguments[at..].iter().any(|arg| arg.ends_with("00000000-0000-4000-8000-0000000000a1")));
        assert!(!arguments.iter().any(|arg| arg.ends_with("00000000-0000-4000-8000-0000000000a3")));
        assert_eq!(arguments.last().map(String::as_str), Some("--json"));
    }
}
