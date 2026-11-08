//! Owner-only endpoint management, with bounded concurrent stdout draining.
use std::{fs, io::{Read, Write}, process::Stdio, thread};
use crate::{paths::{has_executor_state, PAIRED_BY_FILE}, supervisor::{Supervisor, wait_bounded, COMMAND_TIMEOUT}};
impl Supervisor {
    pub fn inference_connections(&self, executor_id: &str, operation: serde_json::Value, sid: Option<&str>)
        -> Result<serde_json::Value, String> {
        let directory = self.state_dir(executor_id)?;
        if !has_executor_state(&directory) { return Err("This team is not paired on this computer.".into()); }
        let owner = fs::read_to_string(directory.join(PAIRED_BY_FILE))
            .map_err(|_| "This connection's owner could not be verified.")?;
        if sid != Some(owner.trim()) { return Err("Only this connection's owner can manage inference servers.".into()); }
        let operation = nessie_windows_common::inference_control::validate(operation)?;
        let mut child = self.command().args(["local-inference", "connections", "--operation-stdin", "--state-dir"])
            .arg(&directory).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().map_err(|_| "Could not start the inference connection controller.")?;
        let stdout = child.stdout.take().ok_or("Inference connection output unavailable.")?;
        let reader = thread::spawn(move || {
            let mut bytes = Vec::new();
            stdout.take(1_048_577).read_to_end(&mut bytes).map(|_| bytes)
        });
        let input = serde_json::to_vec(&operation).map_err(|_| "Invalid inference connection action.")?;
        let supplied = child.stdin.take().ok_or("Inference connection input unavailable.")?.write_all(&input);
        let outcome = wait_bounded(&mut child, COMMAND_TIMEOUT);
        if supplied.is_err() || !matches!(outcome, Ok(Some(0))) {
            let _ = child.kill(); let _ = child.wait(); let _ = reader.join();
            return Err("Could not update inference connections. Check the server address and try again.".into());
        }
        let bytes = reader.join().map_err(|_| "Inference connection response unavailable.")?
            .map_err(|_| "Inference connection response unavailable.")?;
        if bytes.len() > 1_048_576 { return Err("Inference connection response is too large.".into()); }
        serde_json::from_slice(&bytes).map_err(|_| "Invalid inference connection response.".into())
    }
}
