//! The parent's private stdio channel amortizes Windows process startup only.
//! Every request runs the original DACL check again; no positive verdict is retained.
use std::io::{BufRead, Read, Write};
use serde::{Deserialize, Serialize};
use crate::{command::{parse_command, Command}, protocol::NativeError, state_security};

const MAX_FRAME_BYTES: u64 = 65_536;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    request_id: u32,
    command: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    request_id: u32,
    code: Option<String>,
    status: &'static str,
}

fn check(request: &Request) -> Result<&'static str, NativeError> {
    let command = parse_command(&[request.command.clone(), request.path.clone()])?;
    match command {
        Command::SecureDirectory(path) => {
            state_security::secure_directory(&path)?;
            Ok("secured")
        }
        Command::SecureOwnerOnlyFile(path) => {
            state_security::secure_owner_only_file(&path)?;
            Ok("secured")
        }
        Command::VerifyOwnerOnly(path) => {
            state_security::verify_owner_only(&path)?;
            Ok("verified")
        }
        Command::VerifyOwnerOnlyFile(path) => {
            state_security::verify_owner_only_file(&path)?;
            Ok("verified")
        }
        _ => Err(NativeError::new("EXECUTOR_NATIVE_USAGE")),
    }
}

fn serve(input: &mut impl BufRead, output: &mut impl Write) -> Result<(), NativeError> {
    loop {
        let mut frame = Vec::new();
        let bytes = (&mut *input).take(MAX_FRAME_BYTES + 1).read_until(b'\n', &mut frame)
            .map_err(|_| NativeError::new("EXECUTOR_STATE_SECURITY_IO_FAILURE"))?;
        if bytes == 0 { return Ok(()); }
        if bytes as u64 > MAX_FRAME_BYTES || frame.last() != Some(&b'\n') {
            return Err(NativeError::new("EXECUTOR_NATIVE_USAGE"));
        }
        let request: Request = serde_json::from_slice(&frame)
            .map_err(|_| NativeError::new("EXECUTOR_NATIVE_USAGE"))?;
        let response = match check(&request) {
            Ok(status) => Response { request_id: request.request_id, code: None, status },
            Err(error) => Response {
                request_id: request.request_id, code: Some(error.code.to_owned()), status: "rejected",
            },
        };
        serde_json::to_writer(&mut *output, &response)
            .map_err(|_| NativeError::new("EXECUTOR_STATE_SECURITY_IO_FAILURE"))?;
        output.write_all(b"\n").and_then(|()| output.flush())
            .map_err(|_| NativeError::new("EXECUTOR_STATE_SECURITY_IO_FAILURE"))?;
    }
}

pub fn run() -> Result<(), NativeError> {
    serve(&mut std::io::stdin().lock(), &mut std::io::stdout().lock())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn unrelated_commands_and_relative_paths_never_enter_the_native_dispatcher() {
        for (command, path) in [("personal-state-delete", "/private"), ("secure-directory", "relative")] {
            let request = Request { request_id: 1, command: command.into(), path: path.into() };
            assert_eq!(check(&request).unwrap_err().code, "EXECUTOR_NATIVE_USAGE");
        }
    }

    #[test]
    fn channel_refuses_truncated_oversized_or_extra_field_frames() {
        for input in [
            br#"{"requestId":1,"command":"verify-owner-only","path":"/private"}"#.to_vec(),
            vec![b'x'; MAX_FRAME_BYTES as usize + 1],
            b"{\"requestId\":1,\"command\":\"verify-owner-only\",\"path\":\"/private\",\"extra\":true}\n".to_vec(),
        ] {
            let mut output = Vec::new();
            assert!(serve(&mut Cursor::new(input), &mut output).is_err());
            assert!(output.is_empty());
        }
    }
}
