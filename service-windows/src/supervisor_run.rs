//! One-shot packaged commands the service runs to completion: their exit
//! status, an optional payload on standard input, and, for `describe`, the
//! credential-free JSON on standard output.

use std::{
    io::{Read, Write},
    process::Stdio,
};

use crate::supervisor::{wait_bounded, Supervisor, COMMAND_TIMEOUT};

impl Supervisor {
    /// Runs one packaged command to completion. Its output is never captured or
    /// reported: a refusal names what was refused, never what a child printed.
    pub(crate) fn run_to_completion(
        &self,
        arguments: Vec<String>,
        refusal: &str,
    ) -> Result<(), String> {
        let mut child = self
            .command()
            .args(arguments)
            .spawn()
            .map_err(|_| "Nessie Computer could not start its packaged command.".to_owned())?;
        match wait_bounded(&mut child, COMMAND_TIMEOUT)? {
            Some(0) => Ok(()),
            Some(_) => Err(refusal.to_owned()),
            None => {
                // A wedged one-shot command is not a daemon with guests to tear
                // down, and it must not hold the control pipe open forever.
                let _ = child.kill();
                Err(refusal.to_owned())
            }
        }
    }

    /// Runs a one-shot command that reads its payload from stdin. Used for
    /// `configure --configuration-input-stdin` so the whole policy travels on a
    /// pipe, never in a process list.
    pub(crate) fn run_to_completion_with_input(
        &self,
        arguments: Vec<String>,
        input: serde_json::Value,
        refusal: &str,
    ) -> Result<(), String> {
        let mut child = self
            .command()
            .args(arguments)
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|_| "Nessie Computer could not start its packaged command.".to_owned())?;
        let mut standard_input = child.stdin.take().ok_or_else(|| {
            "Nessie Computer could not provide the configuration input securely.".to_owned()
        })?;
        let bytes = serde_json::to_vec(&input)
            .map_err(|_| "Nessie Computer could not prepare the configuration input.".to_owned())?;
        standard_input.write_all(&bytes).map_err(|_| {
            "Nessie Computer could not provide the configuration input securely.".to_owned()
        })?;
        drop(standard_input);
        match wait_bounded(&mut child, COMMAND_TIMEOUT)? {
            Some(0) => Ok(()),
            Some(_) => Err(refusal.to_owned()),
            None => {
                let _ = child.kill();
                Err(refusal.to_owned())
            }
        }
    }

    /// Runs a one-shot command and returns its stdout. Used for `describe`,
    /// whose credential-free JSON is handed straight back to the tray.
    pub(crate) fn run_to_completion_with_output(
        &self,
        arguments: Vec<String>,
        refusal: &str,
    ) -> Result<String, String> {
        let mut child = self
            .command()
            .args(arguments)
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|_| "Nessie Computer could not start its packaged command.".to_owned())?;
        let outcome = wait_bounded(&mut child, COMMAND_TIMEOUT)?;
        let mut stdout = String::new();
        if let Some(mut pipe) = child.stdout.take() {
            let _ = pipe.read_to_string(&mut stdout);
        }
        match outcome {
            Some(0) => Ok(stdout),
            Some(_) => Err(refusal.to_owned()),
            None => {
                let _ = child.kill();
                Err(refusal.to_owned())
            }
        }
    }

}
