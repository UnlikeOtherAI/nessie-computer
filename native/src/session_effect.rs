//! One authenticated inherited pipe, owned only by the host and effect receiver.
//! The host consumes the actual signed session-authority route for the exact wire digest.
//! No machine key, refresh token, pipe handle or permit reaches the provider.
use crate::protocol::NativeError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[path = "session_effect_scope.rs"]
mod scope;

pub const REFUSED: &str = "EXECUTOR_SESSION_EFFECT_REFUSED";
fn refused() -> NativeError {
    NativeError::new(REFUSED)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
const LIMIT: u64 = 512 * 1024;

pub struct Channel {
    incoming: Receiver<Result<Value, ()>>,
    writer: Box<dyn Write + Send>,
    sequence: u64,
    original: Option<Value>,
    issuer_origin: Option<String>,
}

pub struct Frame {
    pub kind: String,
    pub data: String,
    seq: u64,
    digest: String,
}

fn automatic_reply(data: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return false;
    };
    value.is_object()
        && value.get("method").is_none()
        && (value["type"] == "control_response"
            || value.get("id").is_some()
                && (value.get("result").is_some() || value.get("error").is_some()))
}

fn terminal_reply(data: &str) -> bool {
    let bytes = data.as_bytes();
    bytes.len() >= 3
        && bytes.len() <= 64
        && bytes.starts_with(b"\x1b[")
        && b"Rcn".contains(bytes.last().unwrap())
        && bytes[2..bytes.len() - 1]
            .iter()
            .all(|b| b.is_ascii_digit() || b";?".contains(b))
}

impl Channel {
    pub fn new(reader: impl Read + Send + 'static, writer: impl Write + Send + 'static) -> Self {
        let (send, incoming) = mpsc::sync_channel(8);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(reader);
            loop {
                let mut line = String::new();
                let read = (&mut reader).take(LIMIT + 1).read_line(&mut line);
                let valid = read.is_ok()
                    && !line.is_empty()
                    && line.len() as u64 <= LIMIT
                    && line.ends_with('\n');
                let parsed = if valid {
                    serde_json::from_str(&line).map_err(|_| ())
                } else {
                    Err(())
                };
                let failed = parsed.is_err();
                if send.send(parsed).is_err() || failed {
                    break;
                }
            }
        });
        Self {
            incoming,
            writer: Box::new(writer),
            sequence: 0,
            original: None,
            issuer_origin: None,
        }
    }
    fn read(&self, timed: bool) -> Result<Value, NativeError> {
        let value = if timed {
            self.incoming
                .recv_timeout(Duration::from_secs(10))
                .map_err(|_| refused())?
        } else {
            self.incoming.recv().map_err(|_| refused())?
        };
        value.map_err(|_| refused())
    }
    fn send(&mut self, value: Value) -> Result<(), NativeError> {
        let mut bytes = serde_json::to_vec(&value).map_err(|_| refused())?;
        bytes.push(b'\n');
        self.writer
            .write_all(&bytes)
            .and_then(|_| self.writer.flush())
            .map_err(|_| refused())
    }
    pub fn next(&mut self) -> Result<Frame, NativeError> {
        let offer = self.read(self.sequence == 0)?;
        if offer["type"] != "offer" || offer["seq"].as_u64() != Some(self.sequence + 1) {
            return Err(refused());
        }
        let wire = offer["wire"].as_str().ok_or_else(refused)?;
        let frame: Value = serde_json::from_str(wire).map_err(|_| refused())?;
        let kind = frame["kind"].as_str().ok_or_else(refused)?;
        let data = frame["data"].as_str().ok_or_else(refused)?;
        if !["launch", "input", "reply", "terminal_reply", "end"].contains(&kind) {
            return Err(refused());
        }
        let scope = &frame["scope"];
        if scope.is_null() {
            if self.original.is_none()
                || !(kind == "end"
                    || kind == "reply" && automatic_reply(data)
                    || kind == "terminal_reply" && terminal_reply(data))
            {
                return Err(refused());
            }
        } else {
            scope::identity(scope).ok_or_else(refused)?;
            let origin = frame.get("issuerOrigin").and_then(Value::as_str);
            if scope::is_t3(scope) {
                // The managed host verifies this origin against its protected enrolled state
                // before every signed consumption. This field is included in the wire digest.
                if origin.is_none_or(|value| !value.starts_with("https://") || value.len() <= 8) {
                    return Err(refused());
                }
            } else if frame.get("issuerOrigin").is_some() {
                return Err(refused());
            }
            if let Some(first) = &self.original {
                if !scope::same_session(first, scope) || self.issuer_origin.as_deref() != origin {
                    return Err(refused());
                }
            }
            if self
                .original
                .as_ref()
                .is_none_or(|first| !scope::is_t3(first) && first["admissions"].get(0).is_none())
            {
                self.original = Some(scope.clone());
                self.issuer_origin = origin.map(str::to_owned);
            }
        }
        if frame.get("issuerOrigin").and_then(Value::as_str) != self.issuer_origin.as_deref() {
            return Err(refused());
        }
        self.sequence += 1;
        Ok(Frame {
            kind: kind.into(),
            data: data.into(),
            seq: self.sequence,
            digest: format!("{:x}", Sha256::digest(wire.as_bytes())),
        })
    }
    pub fn consume(&mut self, frame: &Frame) -> Result<(), NativeError> {
        let nonce = nonce()?;
        let started = Instant::now();
        self.send(json!({"type":"consume", "seq":frame.seq,"digest":frame.digest,"nonce":nonce}))?;
        let permit = self.read(true)?;
        let until = permit["validUntil"].as_u64().ok_or_else(refused)?;
        if permit["type"] != "permit"
            || permit["seq"] != frame.seq
            || permit["digest"] != frame.digest
            || permit["nonce"] != nonce
            || until <= now()
            || until > now() + 5_000
            || started.elapsed() >= Duration::from_secs(5)
        {
            return Err(refused());
        }
        Ok(())
    }
    pub fn outcome(&mut self, frame: &Frame, status: &str) -> Result<(), NativeError> {
        self.send(json!({"type":"outcome","seq":frame.seq,"digest":frame.digest,"status":status}))
    }
    pub fn launch(&mut self, argv: &[String]) -> Result<Frame, NativeError> {
        let frame = self.next()?;
        let launch: Value = serde_json::from_str(&frame.data).map_err(|_| refused())?;
        let cwd = std::env::current_dir().map_err(|_| refused())?;
        if frame.kind != "launch"
            || launch["command"] != argv[0]
            || launch["args"] != json!(&argv[1..])
            || launch["cwd"] != cwd.to_string_lossy().as_ref()
        {
            return Err(refused());
        }
        Ok(frame)
    }
    pub fn relay(mut self, mut input: impl Write, terminal: bool) -> Result<(), NativeError> {
        loop {
            let frame = self.next()?;
            if !["input", "reply", "end"].contains(&frame.kind.as_str())
                && !(terminal && frame.kind == "terminal_reply")
            {
                return Err(refused());
            }
            if let Err(error) = self.consume(&frame) {
                let _ = self.outcome(&frame, "refused");
                return Err(error);
            }
            if frame.kind == "end" {
                self.outcome(&frame, "accepted")?;
                return Ok(());
            }
            // write_all may partially deliver before an error. Never report a safe retry.
            let mut remaining = frame.data.as_bytes();
            while !remaining.is_empty() {
                if self.consume(&frame).is_err() {
                    let _ = self.outcome(&frame, "uncertain");
                    return Err(refused());
                }
                match input.write(remaining) {
                    Ok(0) | Err(_) => {
                        let _ = self.outcome(&frame, "uncertain");
                        return Err(refused());
                    }
                    Ok(count) => remaining = &remaining[count..],
                }
            }
            if input.flush().is_err() {
                let _ = self.outcome(&frame, "uncertain");
                return Err(refused());
            }
            self.outcome(&frame, "accepted")?;
        }
    }
}

#[cfg(windows)]
fn nonce() -> Result<String, NativeError> {
    use windows_sys::Win32::System::Com::CoCreateGuid;
    let mut guid = unsafe { std::mem::zeroed() };
    if unsafe { CoCreateGuid(&mut guid) } != 0 {
        return Err(refused());
    }
    Ok(format!(
        "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        guid.data1,
        guid.data2,
        guid.data3,
        guid.data4[0],
        guid.data4[1],
        guid.data4[2],
        guid.data4[3],
        guid.data4[4],
        guid.data4[5],
        guid.data4[6],
        guid.data4[7]
    ))
}
#[cfg(not(windows))]
fn nonce() -> Result<String, NativeError> {
    Err(refused())
}

#[cfg(windows)]
pub fn inherited() -> Result<Channel, NativeError> {
    use std::fs::File;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT};
    #[link(name = "msvcrt")]
    extern "C" {
        fn _get_osfhandle(fd: i32) -> isize;
    }
    // libuv's explicit stdio[3] is the only endpoint. No pipe name or bearer secret exists.
    let raw = unsafe { _get_osfhandle(3) };
    if raw == -1 || raw == -2 {
        return Err(refused());
    }
    if unsafe { SetHandleInformation(raw as HANDLE, HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(refused());
    }
    let reader = unsafe { File::from_raw_handle(raw as _) };
    let writer = reader.try_clone().map_err(|_| refused())?;
    if unsafe { SetHandleInformation(writer.as_raw_handle() as HANDLE, HANDLE_FLAG_INHERIT, 0) }
        == 0
    {
        return Err(refused());
    }
    Ok(Channel::new(reader, writer))
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    fn scope(command: &str) -> Value {
        json!({"executorId":"executor", "originalOwnerGeneration":"generation",
        "ownerKey":"owner", "connectionEpoch":"7", "authorizationRevision":2,
        "purpose":"control", "commandId":command, "admissions":[]})
    }
    fn offer(seq: u64, scope: Value, kind: &str, data: &str) -> String {
        json!({"type":"offer","seq":seq,"wire":json!({"kind":kind,"data":data,"scope":scope}).to_string()}).to_string()+"\n"
    }
    #[test]
    fn replay_and_retargeted_original_are_refused_before_consumption() {
        for second in [
            offer(1, scope("start"), "input", "text"),
            offer(2, scope("other"), "input", "text"),
        ] {
            let input = offer(1, scope("start"), "launch", "{}") + &second;
            let mut channel = Channel::new(Cursor::new(input.into_bytes()), Vec::new());
            assert!(channel.next().is_ok());
            assert!(channel.next().is_err());
        }
    }
    #[test]
    fn an_admitted_session_cannot_be_retargeted_with_the_same_start_reference() {
        let mut first = scope("control-one");
        first["admissions"] =
            json!([{"startCommandId":"start","sessionId":"one","evidenceDigest":"digest"}]);
        let mut second = first.clone();
        second["commandId"] = json!("control-two");
        second["admissions"][0]["sessionId"] = json!("two");
        let input = offer(1, first, "launch", "{}") + &offer(2, second, "input", "text");
        let mut channel = Channel::new(Cursor::new(input.into_bytes()), Vec::new());
        assert!(channel.next().is_ok());
        assert!(channel.next().is_err());
    }
    #[test]
    fn missing_authority_never_turns_input_into_a_system_reply() {
        let input =
            offer(1, scope("start"), "launch", "{}") + &offer(2, Value::Null, "input", "text");
        let mut channel = Channel::new(Cursor::new(input.into_bytes()), Vec::new());
        assert!(channel.next().is_ok());
        assert!(channel.next().is_err());
        assert!(!automatic_reply(
            r#"{"id":1,"method":"turn/start","result":{}}"#
        ));
        assert!(automatic_reply(r#"{"id":1,"result":{}}"#));
        assert!(!terminal_reply("\x1b[1R\nexecute"));
        assert!(terminal_reply("\x1b[1;2R"));
    }
    #[test]
    fn malformed_oversized_or_disconnected_channel_refuses() {
        for input in [String::new(), "{}\n".into(), "x".repeat(LIMIT as usize + 1)] {
            let mut channel = Channel::new(Cursor::new(input.into_bytes()), Vec::new());
            assert!(channel.next().is_err());
        }
    }
    #[test]
    fn t3_issuer_origin_cannot_change_or_disappear_on_automatic_replies() {
        let selected = json!({"kind":"t3-effect", "version":1, "purpose":"execute",
            "executorId":"executor", "environmentId":"env", "threadId":"thread",
            "providerSessionId":"provider", "connectionEpoch":"1", "runtimeGeneration":"generation",
            "correlationId":"correlation", "commandId":"command", "requestDigest":"digest",
            "issuedAt":"issued", "expiresAt":"expires", "requestNonce":"nonce", "requestProofDigest":"proof",
            "nativeAssociation":{"driver":"codex", "nativeId":"native", "continuationHomeKey":"continue",
                "historyHomeKey":"history"}});
        let first = json!({"type":"offer", "seq":1, "wire":json!({"kind":"launch", "data":"{}",
            "scope":selected, "issuerOrigin":"https://issuer.example"}).to_string()})
        .to_string()
            + "\n";
        for origin in [Value::Null, json!("https://other.example")] {
            let second = json!({"type":"offer", "seq":2, "wire":json!({"kind":"reply",
                "data":"{\"id\":1,\"result\":{}}", "scope":Value::Null, "issuerOrigin":origin}).to_string()})
                .to_string()+"\n";
            let mut channel = Channel::new(
                Cursor::new((first.clone() + &second).into_bytes()),
                Vec::new(),
            );
            // Parsing a selection does not grant launch; consumption is still mandatory.
            assert!(channel.next().is_ok());
            assert!(channel.next().is_err());
        }
    }
}
