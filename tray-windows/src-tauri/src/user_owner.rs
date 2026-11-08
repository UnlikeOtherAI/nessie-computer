//! The owner's controls for a team this app runs under the person's account.
//!
//! The same packaged CLI verbs the service runs for its own teams, against this
//! account's state directory: `pause` / `resume`, `program-requests`,
//! `program-request answer` and `audience`. The person running this app owns
//! the directory, so they are the owner the requests ask.

use std::path::Path;

use nessie_windows_common::owner_controls::{
    answer_arguments, audience_arguments, parse_program_requests, pause_arguments,
    program_requests_arguments, Answer, ProgramRequest,
};

use crate::user_runtime;

pub fn set_paused(state_dir: &Path, paused: bool) -> Result<(), String> {
    user_runtime::run(&pause_arguments(state_dir, paused), None).map(|_| ())
}

pub fn program_requests(state_dir: &Path) -> Result<Vec<ProgramRequest>, String> {
    parse_program_requests(user_runtime::run(&program_requests_arguments(state_dir), None)?)
}

pub fn answer(state_dir: &Path, id: &str, answer: Answer) -> Result<Vec<ProgramRequest>, String> {
    user_runtime::run(&answer_arguments(state_dir, id, answer)?, None)?;
    program_requests(state_dir)
}

pub fn audience(state_dir: &Path) -> Result<serde_json::Value, String> {
    user_runtime::run(&audience_arguments(state_dir), None)
}
