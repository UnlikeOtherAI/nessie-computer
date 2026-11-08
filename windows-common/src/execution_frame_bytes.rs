//! Reconstruct metadata from one lossless NDJSON frame, never a partial chunk.
use crate::{
    custody::REJECTED,
    execution_frame::{protocol_id, Frame, MAX},
    execution_json,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
pub fn decode(driver: &str, bytes: &[u8]) -> Result<(Frame, Value), String> {
    if bytes.is_empty()
        || bytes.len() > MAX
        || bytes.last() != Some(&b'\n')
        || bytes[..bytes.len() - 1].contains(&b'\n')
    {
        return Err(REJECTED.into());
    }
    let value = execution_json::parse(bytes)?;
    if !value.is_object() {
        return Err(REJECTED.into());
    }
    let (kind, id, message, method) = match driver {
        "codex" => {
            if value.get("method").is_some() {
                if value.get("result").is_some() || value.get("error").is_some() {
                    return Err(REJECTED.into());
                }
                let method = value["method"].as_str().ok_or(REJECTED)?.to_owned();
                let id = value.get("id").cloned();
                let kind = if method == "$/cancelRequest" {
                    "cancel"
                } else if id.is_some() {
                    "request"
                } else {
                    "notification"
                };
                (kind, id, None, Some(method))
            } else {
                if value.get("result").is_some() == value.get("error").is_some() {
                    return Err(REJECTED.into());
                }
                (
                    "response",
                    Some(value.get("id").ok_or(REJECTED)?.clone()),
                    None,
                    None,
                )
            }
        }
        "claude" => match value["type"].as_str() {
            Some("control_request") => (
                "request",
                Some(value.get("request_id").ok_or(REJECTED)?.clone()),
                None,
                Some(value["request"]["subtype"].as_str().ok_or(REJECTED)?.into()),
            ),
            Some("control_cancel_request") => (
                "cancel",
                Some(value.get("request_id").ok_or(REJECTED)?.clone()),
                None,
                None,
            ),
            Some("control_response") => (
                "response",
                Some(value["response"].get("request_id").ok_or(REJECTED)?.clone()),
                None,
                None,
            ),
            Some("user") => (
                "message",
                None,
                value
                    .get("uuid")
                    .map(|v| v.as_str().map(str::to_owned).ok_or(REJECTED))
                    .transpose()?,
                None,
            ),
            _ => return Err(REJECTED.into()),
        },
        _ => return Err(REJECTED.into()),
    };
    if id.as_ref().is_some_and(|v| !protocol_id(v)) {
        return Err(REJECTED.into());
    }
    let frame = Frame {
        driver: driver.into(),
        kind: kind.into(),
        protocol_id: id,
        message_id: message,
        method,
        frame_sha256: format!("sha256:{:x}", Sha256::digest(bytes)),
    };
    frame.validate()?;
    Ok((frame, value))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_bytes_preserve_utf8_and_signed_ids() {
        let bytes = "{\"id\":-1,\"method\":\"thread/start\",\"params\":{\"text\":\"žluťoučký\"}}\n"
            .as_bytes();
        let (frame, _) = decode("codex", bytes).unwrap();
        assert_eq!(frame.protocol_id, Some((-1).into()));
        assert_eq!(
            frame.frame_sha256,
            format!("sha256:{:x}", Sha256::digest(bytes))
        );
        assert!(decode("codex", &bytes[..bytes.len() - 1]).is_err());
    }
    #[test]
    fn refuse_mixed_ambiguous_and_duplicate_frames() {
        for bytes in [
            b"{\"id\":1,\"id\":2,\"method\":\"a\"}\n".as_slice(),
            b"{\"id\":1,\"method\":\"a\",\"params\":{\"x\":1,\"x\":2}}\n",
            b"{\"id\":1,\"method\":\"a\",\"result\":{}}\n",
            b"{}\n{}\n",
        ] {
            assert!(decode("codex", bytes).is_err());
        }
    }
}
