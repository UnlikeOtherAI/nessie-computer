//! Bounded, digest-CAS mutations. Secrets enter stdin and are never printed.
use crate::protocol::NativeError;
#[cfg(windows)]
pub fn verify_windows_deletion() -> Result<Vec<std::fs::File>, NativeError> {
    imp::verify_deletion()
}

pub const MAX_BYTES: u64 = 4 * 1024 * 1024;
pub const IO: &str = "EXECUTOR_PERSONAL_STATE_IO_FAILURE";
pub const REJECTED: &str = "EXECUTOR_PERSONAL_STATE_REJECTED";
pub const CONFLICT: &str = "EXECUTOR_PERSONAL_STATE_CONFLICT";

pub fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

pub fn expected(value: &str) -> Result<Option<String>, NativeError> {
    if value == "absent" {
        return Ok(None);
    }
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Ok(Some(value.to_owned()));
    }
    Err(NativeError::new(REJECTED))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Gate {
    version: u8,
    length: usize,
    digest: String,
}

pub fn read_bytes() -> Result<Vec<u8>, NativeError> {
    use std::io::Read;
    let mut input = Vec::new();
    std::io::stdin()
        .take(MAX_BYTES + 512)
        .read_to_end(&mut input)
        .map_err(|_| NativeError::new(IO))?;
    decode_frame(&input)
}

fn decode_frame(input: &[u8]) -> Result<Vec<u8>, NativeError> {
    let newline = input
        .iter()
        .position(|byte| *byte == b'\n')
        .filter(|position| *position <= 256)
        .ok_or_else(|| NativeError::new(REJECTED))?;
    let gate: Gate =
        serde_json::from_slice(&input[..newline]).map_err(|_| NativeError::new(REJECTED))?;
    let bytes = &input[newline + 1..];
    if gate.version != 1
        || gate.length as u64 > MAX_BYTES
        || gate.length != bytes.len()
        || gate.digest != digest(bytes)
    {
        return Err(NativeError::new(REJECTED));
    }
    Ok(bytes.to_vec())
}

pub fn read_gate() -> Result<(), NativeError> {
    if !read_bytes()?.is_empty() {
        return Err(NativeError::new(REJECTED));
    }
    Ok(())
}

#[cfg(windows)]
#[path = "personal_state/windows.rs"]
mod imp;

#[cfg(not(windows))]
mod imp {
    use super::NativeError;
    pub fn ensure_directory(_: &str) -> Result<(), NativeError> {
        Err(NativeError::new("EXECUTOR_PERSONAL_STATE_UNSUPPORTED"))
    }
    pub fn barrier(_: &str) -> Result<(), NativeError> {
        Err(NativeError::new("EXECUTOR_PERSONAL_STATE_UNSUPPORTED"))
    }
    pub fn mutate(_: &str, _: Option<&str>, _: Option<&[u8]>) -> Result<(), NativeError> {
        Err(NativeError::new("EXECUTOR_PERSONAL_STATE_UNSUPPORTED"))
    }
}

pub use imp::{barrier, ensure_directory, mutate};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_a_complete_gated_frame_can_release_a_writer() {
        let bytes = b"fixture-state";
        let header = format!(
            "{{\"version\":1,\"length\":{},\"digest\":\"{}\"}}\n",
            bytes.len(),
            digest(bytes)
        );
        let mut complete = header.as_bytes().to_vec();
        complete.extend(bytes);
        assert_eq!(decode_frame(&complete).unwrap(), bytes);
        for length in 0..complete.len() {
            assert!(decode_frame(&complete[..length]).is_err());
        }
        assert!(decode_frame(b"raw-state-without-gate").is_err());
        *complete.last_mut().unwrap() ^= 1;
        assert!(decode_frame(&complete).is_err());
    }

    #[test]
    fn expected_digest_is_exact_and_absence_is_explicit() {
        assert_eq!(expected("absent").unwrap(), None);
        assert_eq!(expected(&"a".repeat(64)).unwrap(), Some("a".repeat(64)));
        for invalid in ["", "*", "null", "ABSENT", &"A".repeat(64), &"a".repeat(63)] {
            assert!(expected(invalid).is_err());
        }
        assert_eq!(
            digest(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
