//! The verified packaged CLI, running as the person who opened the executor.
use nessie_windows_common::runtime::verify_packaged_runtime;
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub fn command() -> Result<Command, String> {
    #[cfg(all(windows, not(debug_assertions)))]
    nessie_windows_provenance::require_release_signature(option_env!(
        "NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"
    ))?;
    let root = std::env::current_exe()
        .ok()
        .and_then(|file| file.parent().map(PathBuf::from))
        .ok_or("Could not locate the packaged executor.")?;
    let runtime = verify_packaged_runtime(&root)?;
    let mut command = if cfg!(debug_assertions) {
        let mut command = Command::new(&runtime.node_executable);
        command.arg(runtime.bundle());
        command
    } else {
        let mut command = Command::new(&runtime.native_helper);
        command.args(["managed-runtime", "--"]);
        command
    };
    command
        .env("NESSIE_EXECUTOR_PACKAGED_CLI", "1")
        .env("NESSIE_EXECUTOR_SUPERVISOR", "desktop")
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if cfg!(debug_assertions) {
        command.env("NESSIE_EXECUTOR_ALLOW_LOCAL_API", "1");
    } else {
        command.env_remove("NESSIE_EXECUTOR_ALLOW_LOCAL_API");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Ok(command)
}

pub fn wait(child: &mut Child, duration: Duration) -> Result<bool, String> {
    let deadline = Instant::now() + duration;
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return if status.success() {
                Ok(true)
            } else {
                Err("The local executor refused the request. Check its configuration and server connection.".into())
            };
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// The refusal a failed one-shot command printed: its last non-empty line of
/// standard error, which the CLI writes as a sentence for a person. The macOS
/// app shows the same line.
fn refusal(stderr: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(stderr);
    let line = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .last()?;
    Some(line.chars().take(400).collect())
}

/// Only credential-free JSON projections are read from standard output. A
/// failed command's own refusal is kept, bounded; daemon output never passes here.
pub fn run(
    arguments: &[String],
    input: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut command = command()?;
    command
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start the local executor.")?;
    let output = child
        .stdout
        .take()
        .ok_or("Could not read the local executor.")?;
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        output
            .take(1_048_577)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let mut errors = child
        .stderr
        .take()
        .ok_or("Could not read the local executor.")?;
    // Drained to the end so the child never blocks on a full pipe; only the tail is kept.
    let error_reader = thread::spawn(move || {
        let (mut tail, mut chunk) = (Vec::new(), [0u8; 4096]);
        while let Ok(read) = errors.read(&mut chunk) {
            if read == 0 {
                break;
            }
            tail.extend_from_slice(&chunk[..read]);
            if tail.len() > 16_384 {
                tail.drain(..tail.len() - 16_384);
            }
        }
        tail
    });
    if let Some(input) = input {
        let bytes = serde_json::to_vec(input).map_err(|error| error.to_string())?;
        let mut pipe = child
            .stdin
            .take()
            .ok_or("Could not provide local settings.")?;
        pipe.write_all(&bytes)
            .map_err(|_| "Could not provide local settings.")?;
    }
    match wait(&mut child, Duration::from_secs(120)) {
        Ok(true) => {}
        outcome => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            let printed = error_reader.join().ok().and_then(|bytes| refusal(&bytes));
            return Err(match outcome {
                Err(generic) => printed.unwrap_or(generic),
                Ok(_) => "The local executor request timed out.".into(),
            });
        }
    }
    let _ = error_reader.join();
    let bytes = reader
        .join()
        .map_err(|_| "Could not read the local executor.")?
        .map_err(|_| "Could not read the local executor.")?;
    if bytes.len() > 1_048_576 {
        return Err("The executor response was too large.".into());
    }
    // connect/configure print human-readable acknowledgements; only their success matters.
    if !matches!(
        arguments.first().map(String::as_str),
        Some("describe" | "pairing-start" | "pairing-status" | "pairing-cancel" | "unpair" | "sync" | "local-inference" | "t3-retained")
    ) {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "The local executor returned an invalid response.".into())
}

#[cfg(test)]
mod tests {
    use super::refusal;

    #[test]
    fn a_refused_command_reports_its_own_last_line() {
        assert_eq!(
            refusal(b"\nUse command rules such as \"git *\" or \"npm run *\", one per line.\n\n")
                .as_deref(),
            Some("Use command rules such as \"git *\" or \"npm run *\", one per line."),
        );
        assert_eq!(refusal(b"  \n\n"), None);
        assert_eq!(
            refusal("é".repeat(500).as_bytes()).map(|line| line.chars().count()),
            Some(400)
        );
    }
}
