//! Nonauthoritative graph bootstrap. The daemon receives public stream frames,
//! never the private creator key written directly into protected graph stdin.
use crate::{protected_pipe, protocol::NativeError};
use nessie_windows_common::execution_creator::PIPE;
use std::io::{Read, Write};
fn refused() -> NativeError {
    NativeError::new("EXECUTOR_T3_CREATOR_REFUSED")
}
pub fn start(executor: &str) -> Result<(), NativeError> {
    crate::personal_state_context::require_release()?;
    let mut pipe = protected_pipe::client(PIPE)?;
    protected_pipe::write(
        &mut pipe,
        &serde_json::json!({"operation":"start","executorId":executor}),
    )?;
    let mut input_pipe = pipe.try_clone().map_err(|_| refused())?;
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        loop {
            let mut header = [0; 4];
            if input.read_exact(&mut header).is_err() {
                break;
            }
            let size = u32::from_le_bytes(header) as usize;
            if size == 0 || size > protected_pipe::MAX {
                break;
            }
            let mut bytes = vec![0; size];
            if input.read_exact(&mut bytes).is_err() {
                break;
            }
            let Ok(value) = serde_json::from_slice(&bytes) else {
                break;
            };
            if protected_pipe::write(&mut input_pipe, &value).is_err() {
                break;
            }
        }
        let _ = protected_pipe::write(&mut input_pipe, &serde_json::json!({"kind":"stop"}));
    });
    let mut reader = protected_pipe::Reader::new();
    let mut output = std::io::stdout().lock();
    loop {
        if let Some(value) = reader.poll(&mut pipe)? {
            let bytes = serde_json::to_vec(&value).map_err(|_| refused())?;
            output
                .write_all(&(bytes.len() as u32).to_le_bytes())
                .and_then(|()| output.write_all(&bytes))
                .and_then(|()| output.flush())
                .map_err(|_| refused())?;
            if value["kind"] == "closed" && value["cleared"] == true {
                return Ok(());
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}
