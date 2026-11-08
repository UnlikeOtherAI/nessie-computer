use super::{handles::{fail, wide}, resource::{hex, Resource}};
use crate::protocol::NativeError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs::File, io::{Read, Write}, os::windows::io::FromRawHandle, path::Path};
use windows_sys::Win32::{Foundation::{GetLastError, LocalFree, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE},
    Security::SECURITY_ATTRIBUTES, Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX},
    System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId,
        PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT}};

const MAX_FRAME: usize = 16 * 1024 * 1024;

/// Independent request/response domains and strict sequence numbers prevent
/// reflection/replay. The key crosses only the child's private stdin, never the
/// named pipe or its name. This also authenticates the server to Node, which
/// cannot query a Windows pipe server PID with its supported builtin APIs.
pub fn mac(key: &[u8], direction: &str, sequence: u64, body: &str) -> String {
    let mut inner = [0x36_u8; 64]; let mut outer = [0x5c_u8; 64];
    for (i, byte) in key.iter().enumerate() { inner[i] ^= byte; outer[i] ^= byte; }
    let mut hash = Sha256::new(); hash.update(inner);
    hash.update(format!("t3-source-v1:{direction}:{sequence}:")); hash.update(body.as_bytes());
    let mut result = Sha256::new(); result.update(outer); result.update(hash.finalize());
    hex(&result.finalize())
}
fn read_frame(file: &mut File) -> Result<Value, NativeError> {
    let mut size = [0; 4]; file.read_exact(&mut size).map_err(|_| fail())?;
    let size = u32::from_le_bytes(size) as usize;
    if size == 0 || size > MAX_FRAME { return Err(fail()); }
    let mut data = vec![0; size]; file.read_exact(&mut data).map_err(|_| fail())?;
    serde_json::from_slice(&data).map_err(|_| fail())
}
fn write_frame(file: &mut File, value: &Value) -> Result<(), NativeError> {
    let bytes = serde_json::to_vec(value).map_err(|_| fail())?;
    if bytes.len() > MAX_FRAME { return Err(fail()); }
    file.write_all(&(bytes.len() as u32).to_le_bytes()).map_err(|_| fail())?;
    file.write_all(&bytes).map_err(|_| fail())?;
    file.flush().map_err(|_| fail())
}
pub fn serve(request: &Value, mut resource: Resource) -> Result<(), NativeError> {
    let nonce = request["nonce"].as_str().ok_or_else(fail)?;
    let secret = request["secret"].as_str().ok_or_else(fail)?;
    if nonce.len() != 64 || secret.len() != 64 || !nonce.bytes().chain(secret.bytes()).all(|c| c.is_ascii_hexdigit()) {
        return Err(fail());
    }
    let key = (0..64).step_by(2).map(|i| u8::from_str_radix(&secret[i..i+2], 16).map_err(|_| fail()))
        .collect::<Result<Vec<_>, _>>()?;
    let parent = u32::try_from(request["parentPid"].as_u64().ok_or_else(fail)?).map_err(|_| fail())?;
    let pipe = format!(r"\\.\pipe\nessie-t3-source-{nonce}");
    let descriptor = crate::state_security::private_pipe_descriptor()?;
    let attributes = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor, bInheritHandle: 0 };
    let handle = unsafe { CreateNamedPipeW(wide(Path::new(&pipe)).as_ptr(),
        PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1, 65536, 65536, 0, &attributes) };
    unsafe { LocalFree(descriptor); }
    if handle == INVALID_HANDLE_VALUE { return Err(fail()); }
    let mut file = unsafe { File::from_raw_handle(handle) };
    println!("{}", json!({"pipe":pipe,"protocol":1}));
    std::io::stdout().flush().map_err(|_| fail())?;
    if unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) } == 0
        && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED { return Err(fail()); }
    let mut client = 0;
    if unsafe { GetNamedPipeClientProcessId(handle, &mut client) } == 0 || client != parent { return Err(fail()); }
    for sequence in 1..=1_000_000_u64 {
        let frame = read_frame(&mut file)?;
        let body = frame["body"].as_str().ok_or_else(fail)?;
        let expected = mac(&key, "request", sequence, body);
        let supplied = frame["mac"].as_str().ok_or_else(fail)?;
        if frame["sequence"] != sequence || supplied.len() != expected.len()
            || supplied.bytes().zip(expected.bytes()).fold(0_u8, |difference, (a,b)| difference | (a ^ b)) != 0 {
            return Err(fail());
        }
        let message: Value = serde_json::from_str(body).map_err(|_| fail())?;
        let result = dispatch(&message, &mut resource).and_then(|value| { resource.recheck()?; Ok(value) });
        let rejected = result.is_err();
        let response = match result { Ok(value) => json!({"ok":true,"value":value}),
            Err(_) => json!({"ok":false,"code":"t3_source_resource_changed_or_unavailable"}) };
        let response = serde_json::to_string(&response).map_err(|_| fail())?;
        write_frame(&mut file, &json!({"sequence":sequence,"mac":mac(&key,"response",sequence,&response),"body":response}))?;
        if rejected || message["op"] == "close" { return Ok(()); }
    }
    Err(fail())
}
pub(super) fn dispatch(request: &Value, resource: &mut Resource) -> Result<Value, NativeError> {
    resource.recheck()?;
    match request["op"].as_str().ok_or_else(fail)? {
        "describe" => Ok(resource.description.clone()),
        "recheck" | "close" => Ok(json!({})),
        "transaction" => resource.database.transaction(request["action"].as_str().ok_or_else(fail)?),
        "query" => resource.database.query(request["query"].as_str().ok_or_else(fail)?, request["table"].as_str()),
        "next" => resource.database.next(request["statement"].as_u64().ok_or_else(fail)?),
        "finalize" => { resource.database.finish(request["statement"].as_u64().ok_or_else(fail)?)?; Ok(json!({})) },
        _ => Err(fail()),
    }
}
