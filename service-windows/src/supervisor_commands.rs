//! One-shot packaged CLI commands owned by the Windows service supervisor.

use std::{
    fs,
    io::{Read, Write},
    path::Path,
    process::Stdio,
};

use nessie_windows_common::unpair::{parse_unpair_output, unpair_arguments};

use crate::{
    lease::unowned_daemon_is_stopping,
    log::log_line,
    paths::{executor_state_dir, executors_root, has_executor_state, pending_root, PAIRED_BY_FILE},
    protocol::PairCommand,
    supervisor::{parse_fingerprint, wait_bounded, Supervisor, COMMAND_TIMEOUT},
};

/// The argv builders keep policy, pairing challenges, and workspace paths out
/// of process lists wherever the packaged CLI supports standard input.
pub(crate) fn pair_arguments(
    api_base_url: &str,
    enrollment_id: &str,
    state_dir: &Path,
) -> Vec<String> {
    vec![
        "pair".to_owned(),
        "--api".to_owned(),
        api_base_url.to_owned(),
        "--enrollment".to_owned(),
        enrollment_id.to_owned(),
        "--pair-input-stdin".to_owned(),
        "--state-dir".to_owned(),
        state_dir.display().to_string(),
    ]
}
pub(crate) fn serve_arguments(state_dir: &Path) -> Vec<String> {
    vec![
        "serve".to_owned(),
        "--parent-liveness-stdin".to_owned(),
        "--state-dir".to_owned(),
        state_dir.display().to_string(),
    ]
}
pub(crate) fn configure_arguments(state_dir: &Path, operation_keys: &[String]) -> Vec<String> {
    vec![
        "configure".to_owned(),
        "--state-dir".to_owned(),
        state_dir.display().to_string(),
        "--operations".to_owned(),
        operation_keys.join(","),
    ]
}
pub(crate) fn configure_input_arguments(state_dir: &Path) -> Vec<String> {
    vec![
        "configure".to_owned(),
        "--configuration-input-stdin".to_owned(),
        "--state-dir".to_owned(),
        state_dir.display().to_string(),
    ]
}
pub(crate) fn describe_arguments(state_dir: &Path) -> Vec<String> {
    vec![
        "describe".to_owned(),
        "--state-dir".to_owned(),
        state_dir.display().to_string(),
    ]
}

impl Supervisor {
    /// Applies the small operation-key policy. The CLI writes the new revision
    /// and tells a running daemon, which keeps its connection: saving never
    /// restarts a team.
    pub fn configure(
        &mut self,
        executor_id: &str,
        operation_keys: &[String],
    ) -> Result<(), String> {
        let state_dir = self.state_dir(executor_id)?;
        if !has_executor_state(&state_dir) {
            return Err("This team is not connected on this computer.".to_owned());
        }
        self.run_to_completion(
            configure_arguments(&state_dir, operation_keys),
            "The Nessie Computer service refused this change. Check the rules and try again.",
        )
    }

    pub fn describe(&mut self, executor_id: &str) -> Result<serde_json::Value, String> {
        let state_dir = self.state_dir(executor_id)?;
        if !has_executor_state(&state_dir) {
            return Err("This team is not connected on this computer.".to_owned());
        }
        let output = self.run_to_completion_with_output(
            describe_arguments(&state_dir),
            "This team’s settings on this computer could not be read.",
        )?;
        serde_json::from_str(&output)
            .map_err(|_| "Nessie Computer couldn’t understand its service’s reply. Try again, or restart Nessie Computer.".to_owned())
    }

    /// Applies the full stdin-only policy representation. Like the
    /// operation-key command it is applied live: the CLI's compare-and-set
    /// writer serialises it against the daemon, which re-signs and keeps its
    /// connection.
    pub fn configure_input(
        &mut self,
        executor_id: &str,
        input: serde_json::Value,
    ) -> Result<(), String> {
        let state_dir = self.state_dir(executor_id)?;
        if !has_executor_state(&state_dir) {
            return Err("This team is not connected on this computer.".to_owned());
        }
        self.run_to_completion_with_input(
            configure_input_arguments(&state_dir),
            input,
            "The Nessie Computer service refused this change. Check the rules and try again.",
        )
    }

    /// Removes one service connection from this computer: its daemon is
    /// stopped the way Stop stops it, then the packaged CLI's `unpair` signs
    /// off with Nessie (best effort) and deletes the state directory. The
    /// answer is whether Nessie heard the sign-off. A daemon that is still
    /// tearing down, or a lease another process holds, refuses the removal
    /// rather than pulling state out from under live guests. A removal that
    /// fails leaves the connection stopped rather than restarting what the
    /// person asked to remove; Start brings it back.
    ///
    /// Like Start, Stop and configuration, removal is open to every account
    /// the control pipe admits; the account that asked is recorded in the log.
    pub fn remove(&mut self, executor_id: &str, requested_by: Option<&str>) -> Result<bool, String> {
        let state_dir = self.state_dir(executor_id)?;
        if !has_executor_state(&state_dir) {
            return Err("This team is not connected on this computer.".to_owned());
        }
        self.stop(executor_id)?;
        if unowned_daemon_is_stopping(&state_dir) {
            return Err(
                "This connection is still running elsewhere on this computer. Stop it there first."
                    .to_owned(),
            );
        }
        let output = self.run_to_completion_with_output(
            unpair_arguments(&state_dir),
            "The Nessie Computer service couldn’t remove this team. Try again.",
        )?;
        let signed_off = parse_unpair_output(output.as_bytes())?;
        self.forget(executor_id, &state_dir)?;
        log_line(
            &self.root,
            &format!(
                "executor {executor_id} removed from this computer by {}; sign-off reached Nessie: {signed_off}",
                requested_by.unwrap_or("an unidentified account"),
            ),
        );
        Ok(signed_off)
    }

    /// Drops what the service itself kept beside the CLI's state. The CLI
    /// deletes its own files; `paired-by.sid` is this service's, so it goes
    /// here, and the directory with it once nothing else is left.
    fn forget(&mut self, executor_id: &str, state_dir: &Path) -> Result<(), String> {
        if has_executor_state(state_dir) {
            return Err("The team was disconnected but its settings are still here.".to_owned());
        }
        self.children.remove(executor_id);
        match fs::remove_file(state_dir.join(PAIRED_BY_FILE)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Nessie Computer could not forget who paired this connection.".to_owned()),
        }
        match fs::remove_dir(state_dir) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            // Not a paired executor any more (no state file), so it is gone from
            // every list; files nobody named are left for a person to inspect.
            Err(_) => log_line(
                &self.root,
                &format!("executor {executor_id} was removed but its directory still holds other files"),
            ),
        }
        Ok(())
    }

    /// Pairs in a staging directory whose name is controlled by the enrollment
    /// request; only a successful API reply chooses the durable executor id.
    pub fn pair(
        &mut self,
        command: &PairCommand,
        paired_by: Option<&str>,
        secure: impl Fn(&Path) -> Result<(), String>,
    ) -> Result<(String, String), String> {
        let staging = pending_root(&self.root).join(&command.enrollment_id);
        let _ = fs::remove_dir_all(&staging);
        secure(&staging)?;
        let output = self.run_pair(command, &staging).inspect_err(|_| {
            let _ = fs::remove_dir_all(&staging);
        })?;
        let fingerprint = parse_fingerprint(&output).ok_or_else(|| {
            "Pairing succeeded but returned no fingerprint.".to_owned()
        })?;
        Ok((self.promote(&staging, paired_by)?, fingerprint))
    }

    fn run_pair(&self, command: &PairCommand, staging: &Path) -> Result<String, String> {
        let mut child = self
            .command()
            .args(pair_arguments(
                &command.api_base_url,
                &command.enrollment_id,
                staging,
            ))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|_| "Nessie Computer could not start its packaged command.".to_owned())?;
        let mut stdin = child.stdin.take().ok_or_else(|| {
            "Nessie Computer could not provide the pairing challenge securely.".to_owned()
        })?;
        let input = serde_json::to_vec(&serde_json::json!({
            "challenge": command.challenge,
            "workspaceRoot": command.workspace_root,
        }))
        .map_err(|_| "Nessie Computer could not prepare the local pairing input.".to_owned())?;
        stdin.write_all(&input).map_err(|_| {
            "Nessie Computer could not provide the pairing challenge securely.".to_owned()
        })?;
        drop(stdin);
        let outcome = wait_bounded(&mut child, COMMAND_TIMEOUT)?;
        if outcome != Some(0) {
            // A timed-out child can keep stdout open forever. Kill and reap it
            // before reading, otherwise pairing can wedge the control pipe.
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "Pairing was rejected. No pairing output was retained.".to_owned(),
            );
        }
        let mut output = String::new();
        if let Some(mut stdout) = child.stdout.take() {
            let _ = stdout.read_to_string(&mut output);
        }
        Ok(output)
    }

    /// Promotes the API-named staged pairing without ever overwriting an
    /// existing machine key.
    pub(crate) fn promote(&self, staging: &Path, paired_by: Option<&str>) -> Result<String, String> {
        let state: serde_json::Value = serde_json::from_slice(
            &fs::read(staging.join(crate::paths::EXECUTOR_STATE_FILE))
                .map_err(|_| "Pairing left no usable settings on this computer.".to_owned())?,
        )
        .map_err(|_| "Pairing left no usable settings on this computer.".to_owned())?;
        let executor_id = state
            .get("executorId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "Pairing left no usable settings on this computer.".to_owned())?
            .to_owned();
        let destination = executor_state_dir(&self.root, &executor_id)?;
        if destination.exists() {
            return Err("This team is already connected on this computer.".to_owned());
        }
        fs::create_dir_all(executors_root(&self.root))
            .map_err(|_| "Nessie Computer could not save the new team’s settings.".to_owned())?;
        fs::rename(staging, &destination)
            .map_err(|_| "Nessie Computer could not save the new team’s settings.".to_owned())?;
        if let Some(sid) = paired_by {
            fs::write(destination.join(PAIRED_BY_FILE), format!("{sid}\n"))
                .map_err(|_| "Nessie Computer could not record the pairing account.".to_owned())?;
        }
        Ok(executor_id)
    }
}
