//! One bounded, private-pipe public JSON command; readers drain while the CLI runs.
use std::{io::{Read, Write}, process::Stdio, thread};
use crate::supervisor::{Supervisor, wait_bounded, COMMAND_TIMEOUT};

impl Supervisor {
    pub(crate) fn public_json_command(&self, arguments: Vec<String>, input: Option<serde_json::Value>)
        -> Result<(i32, String), String> {
        let mut command = self.command();
        command.args(arguments).stdout(Stdio::piped());
        if input.is_some() { command.stdin(Stdio::piped()); }
        let mut child = command.spawn().map_err(|_| "The local executor command could not start.")?;
        let output = child.stdout.take().ok_or("The local executor response is unavailable.")?;
        let reader = thread::spawn(move || {
            let mut bytes = Vec::new();
            let mut output = output;
            let mut buffer = [0_u8; 4096];
            let mut overflow = false;
            loop {
                let count = output.read(&mut buffer).map_err(|_| "The local executor response is unavailable.")?;
                if count == 0 { break; }
                if bytes.len() + count > 65_536 { overflow = true; }
                else if !overflow { bytes.extend_from_slice(&buffer[..count]); }
            }
            if overflow { return Err("The local executor response is too large."); }
            String::from_utf8(bytes).map_err(|_| "The local executor response is invalid.")
        });
        let supplied = if let Some(input) = input {
            child.stdin.take().ok_or("The local executor input is unavailable.")
                .and_then(|mut pipe| serde_json::to_vec(&input).map_err(|_| "Invalid local executor operation.")
                    .and_then(|bytes| pipe.write_all(&bytes).map_err(|_| "The local executor input failed.")))
        } else { Ok(()) };
        let status = wait_bounded(&mut child, COMMAND_TIMEOUT);
        if !matches!(status, Ok(Some(_))) {
            let _ = child.kill();
            let _ = child.wait();
        }
        let output = reader.join().map_err(|_| "The local executor response is unavailable.")?
            .map_err(str::to_owned)?;
        supplied.map_err(str::to_owned)?;
        let status = status?.ok_or("The local executor command is still pending.")?;
        Ok((status, output))
    }
}
