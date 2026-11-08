//! `--control`: one request to the running service, made by the person who
//! typed a `nessie-computer` command.
//!
//! The command line is Node and cannot check who serves a named pipe, so it
//! runs this signed executable instead. Started under the person's own account,
//! it reads one request line from standard input, opens the control pipe as
//! that account, verifies that the signed service is the server
//! (`nessie_windows_common::control_channel`), and writes the one answer line
//! to standard output. It is a client: the pipe's DACL and the service decide
//! what the account may do, as they do for the Windows app. Nothing it reads or
//! writes is logged.

use std::io::{Read, Write};

use nessie_windows_common::control_channel;

use crate::protocol_values::MAX_REQUEST_BYTES;

const MALFORMED: &str = "{\"status\":\"error\",\"reason\":\"The control request is malformed.\"}\n";

const PIN: Option<&str> = option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");

/// The answer for one request line: the service's own, or why it was not asked.
fn relay(input: &str, call: impl FnOnce(&str) -> Result<String, control_channel::Unreachable>) -> String {
    match control_channel::request_line(input, MAX_REQUEST_BYTES) {
        Some(line) => call(&line).unwrap_or_else(control_channel::Unreachable::answer),
        None => MALFORMED.to_owned(),
    }
}

#[cfg(windows)]
fn ask(line: &str) -> Result<String, control_channel::Unreachable> {
    control_channel::call(line, PIN)
}

#[cfg(not(windows))]
fn ask(_line: &str) -> Result<String, control_channel::Unreachable> {
    let _ = PIN;
    Err(control_channel::Unreachable::NotRunning)
}

pub fn run() -> Result<(), String> {
    let mut input = String::new();
    std::io::stdin()
        .take(MAX_REQUEST_BYTES as u64 + 2)
        .read_to_string(&mut input)
        .map_err(|_| "The control request could not be read.".to_owned())?;
    let answer = relay(&input, ask);
    let mut output = std::io::stdout();
    output
        .write_all(answer.as_bytes())
        .and_then(|()| output.flush())
        .map_err(|_| "The control answer could not be written.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{relay, MALFORMED};
    use nessie_windows_common::control_channel::Unreachable;

    #[test]
    fn one_well_formed_line_reaches_the_service_and_its_answer_comes_back_unchanged() {
        let answer = relay("{\"command\":\"status\"}\n", |line| {
            assert_eq!(line, "{\"command\":\"status\"}\n");
            Ok("{\"status\":\"ok\",\"executors\":[]}\n".to_owned())
        });
        assert_eq!(answer, "{\"status\":\"ok\",\"executors\":[]}\n");
    }

    #[test]
    fn an_unreachable_service_is_reported_and_a_malformed_line_is_never_sent() {
        assert_eq!(
            relay("{\"command\":\"status\"}\n", |_| Err(Unreachable::NotTrusted)),
            "{\"status\":\"unreachable\",\"reason\":\"notTrusted\"}\n",
        );
        for input in ["", "status\n", "{\"command\":\"status\"}\n{\"command\":\"remove\"}\n"] {
            assert_eq!(relay(input, |_| panic!("a malformed request must not be sent")), MALFORMED, "{input:?}");
        }
    }
}
