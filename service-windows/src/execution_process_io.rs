//! Service-owned provider stdin/stdout. Native hosts cannot forward arbitrary
//! stdin, fabricate native IDs, or substitute output for the registered child.
use crate::execution_key::Key;
use nessie_windows_common::{
    custody::{Generation, REJECTED},
    custody_observation::job_members,
    execution::{now_ms, Admission, Descriptor, ProcessPurpose, HISTORY_RESULT_DOMAIN},
    execution_process::Record,
    process::{Owned, Process},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Write},
    os::windows::io::FromRawHandle,
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE},
    Storage::FileSystem::{GetFileType, FILE_TYPE_PIPE},
    System::{
        JobObjects::{OpenJobObjectW, TerminateJobObject},
        Threading::{
            GetCurrentProcess, GetExitCodeProcess, GetProcessIdOfThread, OpenProcess, ResumeThread,
            PROCESS_DUP_HANDLE, THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
        },
    },
};
enum Input {
    Bytes(Vec<u8>, u64, mpsc::SyncSender<Result<(), String>>),
    End(mpsc::SyncSender<Result<(), String>>),
}
pub(crate) struct Observation {
    pub record: Record,
    pub child: Generation,
    pub frame: Option<Value>,
    pub failed: bool,
    pub pending: BTreeMap<String, (Value, u64)>,
    pub used_ids: std::collections::BTreeSet<String>,
    pub initialization_written: bool,
    eof: bool,
    result_digest: Option<String>,
    result_bytes: u64,
    process: Process,
    thread: Owned,
    input: Option<mpsc::SyncSender<Input>>,
}
static OBSERVED: Mutex<BTreeMap<String, Arc<Mutex<Observation>>>> = Mutex::new(BTreeMap::new());
fn duplicate(process: HANDLE, value: u64) -> Result<File, String> {
    let raw: usize = value.try_into().map_err(|_| REJECTED)?;
    let mut copy = std::ptr::null_mut();
    if unsafe {
        DuplicateHandle(
            process,
            raw as HANDLE,
            GetCurrentProcess(),
            &mut copy,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(REJECTED.into());
    }
    let file = unsafe { File::from_raw_handle(copy) };
    if unsafe { GetFileType(copy) } != FILE_TYPE_PIPE {
        return Err(REJECTED.into());
    }
    Ok(file)
}
pub(crate) fn get(nonce: &str) -> Result<Arc<Mutex<Observation>>, String> {
    OBSERVED
        .lock()
        .map_err(|_| REJECTED)?
        .get(nonce)
        .cloned()
        .ok_or(REJECTED.into())
}
fn terminate(record: &Record) {
    let wide: Vec<u16> = record.job_name.encode_utf16().chain(Some(0)).collect();
    let job = Owned(unsafe { OpenJobObjectW(0x0008, 0, wide.as_ptr()) });
    if !job.0.is_null() {
        unsafe { TerminateJobObject(job.0, 125) };
    }
}
pub fn attach(
    caller: &Process,
    record: &Record,
    child: &Process,
    thread: u64,
    stdin: u64,
    stdout: u64,
    output: u64,
) -> Result<(), String> {
    let process = Owned(unsafe { OpenProcess(PROCESS_DUP_HANDLE, 0, caller.generation.pid) });
    if process.0.is_null() {
        return Err(REJECTED.into());
    }
    let mut input = duplicate(process.0, stdin)?;
    let mut reader = duplicate(process.0, stdout)?;
    let mut writer = duplicate(process.0, output)?;
    let actual = Process::open(child.generation.pid)?;
    if actual.generation != child.generation {
        return Err(REJECTED.into());
    }
    let mut copied = std::ptr::null_mut();
    let remote: usize = thread.try_into().map_err(|_| REJECTED)?;
    if unsafe {
        DuplicateHandle(
            process.0,
            remote as HANDLE,
            GetCurrentProcess(),
            &mut copied,
            THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
            0,
            0,
        )
    } == 0
    {
        return Err(REJECTED.into());
    }
    let thread = Owned(copied);
    if unsafe { GetProcessIdOfThread(thread.0) } != child.generation.pid {
        return Err(REJECTED.into());
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    let observation = Arc::new(Mutex::new(Observation {
        record: record.clone(),
        child: child.generation.clone(),
        frame: None,
        failed: false,
        pending: BTreeMap::new(),
        used_ids: Default::default(),
        initialization_written: false,
        eof: false,
        result_digest: None,
        result_bytes: 0,
        process: actual,
        thread,
        input: Some(sender),
    }));
    let mut all = OBSERVED.lock().map_err(|_| REJECTED)?;
    if all.len() >= 256 || all.contains_key(&record.nonce) {
        return Err(REJECTED.into());
    }
    all.insert(record.nonce.clone(), observation.clone());
    drop(all);
    std::thread::spawn(move || {
        while let Ok(message) = receiver.recv() {
            match message {
                Input::Bytes(mut bytes, deadline, reply) => {
                    let result = (|| -> Result<(), String> {
                        for part in bytes.chunks(16384) {
                            if now_ms()? >= deadline {
                                return Err(REJECTED.into());
                            }
                            input.write_all(part).map_err(|_| REJECTED)?;
                        }
                        input.flush().map_err(|_| REJECTED.into())
                    })();
                    bytes.fill(0);
                    let failed = result.is_err();
                    let _ = reply.send(result);
                    if failed {
                        break;
                    }
                }
                Input::End(reply) => {
                    drop(input);
                    let _ = reply.send(Ok(()));
                    break;
                }
            }
        }
    });
    std::thread::spawn(move || {
        let mut bytes = [0u8; 16384];
        let mut partial = Vec::new();
        let mut hash = Sha256::new();
        let mut size = 0u64;
        let result = (|| -> Result<(), String> {
            loop {
                let n = reader.read(&mut bytes).map_err(|_| REJECTED)?;
                if n == 0 {
                    break;
                }
                hash.update(&bytes[..n]);
                size += n as u64;
                let inspection = (|| -> Result<(), String> {
                    let mut held = observation.lock().map_err(|_| REJECTED)?;
                    if held.record.admission.process_purpose != Some(ProcessPurpose::Provider)
                        && size > 1_048_576
                    {
                        return Err(REJECTED.into());
                    }
                    if held.record.admission.process_purpose == Some(ProcessPurpose::Provider) {
                        for byte in &bytes[..n] {
                            partial.push(*byte);
                            if partial.len() > 131072 {
                                return Err(REJECTED.into());
                            }
                            if *byte == b'\n' {
                                let value = nessie_windows_common::execution_json::parse(&partial)?;
                                let correlated = if held.record.admission.binding.driver == "codex"
                                {
                                    serde_json::to_string(&value["id"])
                                        .is_ok_and(|id| held.used_ids.contains(&id))
                                } else {
                                    held.initialization_written
                                };
                                if let Some(frame) = crate::execution_observation::native_identity(
                                    &held.record.admission.binding.driver,
                                    &partial,
                                )
                                .filter(|_| correlated)
                                {
                                    if held
                                        .frame
                                        .as_ref()
                                        .is_some_and(|old| old["nativeId"] != frame["nativeId"])
                                    {
                                        return Err(REJECTED.into());
                                    }
                                    held.frame = Some(frame);
                                }
                                let id = if held.record.admission.binding.driver == "codex"
                                    && value["method"].is_string()
                                {
                                    value.get("id")
                                } else if value["type"] == "control_request" {
                                    value.get("request_id")
                                } else {
                                    None
                                };
                                if let Some(id) = id {
                                    if !nessie_windows_common::execution_frame::protocol_id(id) {
                                        return Err(REJECTED.into());
                                    }
                                    let key = serde_json::to_string(id).map_err(|_| REJECTED)?;
                                    if held.pending.len() >= 256
                                        || held
                                            .pending
                                            .insert(key, (id.clone(), now_ms()?))
                                            .is_some()
                                    {
                                        return Err(REJECTED.into());
                                    }
                                }
                                partial.clear();
                            }
                        }
                    }
                    Ok(())
                })();
                writer
                    .write_all(&bytes[..n])
                    .and_then(|()| writer.flush())
                    .map_err(|_| REJECTED)?;
                inspection?;
            }
            Ok(())
        })();
        if let Ok(mut held) = observation.lock() {
            held.failed |= result.is_err() || !partial.is_empty();
            held.eof = true;
            held.result_bytes = size;
            held.result_digest = Some(format!("sha256:{:x}", hash.finalize()));
            if held.failed {
                terminate(&held.record);
            }
        }
    });
    Ok(())
}
pub(crate) fn write(nonce: &str, bytes: Vec<u8>, deadline: u64) -> Result<(), String> {
    let held = get(nonce)?;
    let (sender, record) = {
        let held = held.lock().map_err(|_| REJECTED)?;
        if held.failed {
            return Err(REJECTED.into());
        }
        (held.input.clone().ok_or(REJECTED)?, held.record.clone())
    };
    let (send, receive) = mpsc::sync_channel(1);
    sender
        .try_send(Input::Bytes(bytes, deadline, send))
        .map_err(|_| REJECTED)?;
    match receive.recv_timeout(Duration::from_secs(4)) {
        Ok(Ok(())) => Ok(()),
        _ => {
            if let Ok(mut held) = held.lock() {
                held.failed = true;
            }
            terminate(&record);
            Err(REJECTED.into())
        }
    }
}
pub fn clear(nonce: &str) -> Result<(), String> {
    let held = get(nonce)?;
    let mut held = held.lock().map_err(|_| REJECTED)?;
    if !nessie_windows_common::custody_observation::absent(&held.child)?
        || !job_members(&held.record.job_name)?.is_empty()
    {
        return Err(REJECTED.into());
    }
    held.input.take();
    held.pending.clear();
    Ok(())
}
pub fn end(nonce: &str) -> Result<(), String> {
    let held = get(nonce)?;
    let input = held
        .lock()
        .map_err(|_| REJECTED)?
        .input
        .take()
        .ok_or(REJECTED)?;
    let (send, receive) = mpsc::sync_channel(1);
    input.try_send(Input::End(send)).map_err(|_| REJECTED)?;
    receive
        .recv_timeout(Duration::from_secs(4))
        .map_err(|_| REJECTED)?
}
pub fn consume(
    reservation: &str,
    admission: &Admission,
    descriptor: &Descriptor,
) -> Result<Value, String> {
    let all = OBSERVED.lock().map_err(|_| REJECTED)?;
    let selected = all
        .values()
        .find(|v| {
            v.lock()
                .is_ok_and(|v| v.record.admission.reservation_id == reservation)
        })
        .cloned()
        .ok_or(REJECTED)?;
    drop(all);
    let held = selected.lock().map_err(|_| REJECTED)?;
    let actual = Process::open(held.child.pid)?;
    if held.failed
        || held.record.descriptor != *descriptor
        || actual.generation != held.child
        || !actual.alive()
        || admission.process_purpose != Some(ProcessPurpose::Provider)
        || admission.provider_session_id.as_deref() != Some(&held.record.provider_session_id)
        || admission.launch_digest != held.record.admission.launch_digest
    {
        return Err(REJECTED.into());
    }
    let mut value = held.frame.clone().ok_or(REJECTED)?;
    value["provider"] = serde_json::to_value(&held.child).map_err(|_| REJECTED)?;
    value["providerImageDigest"] = json!(held.record.image_digest);
    Ok(value)
}
pub fn history_result(record: &Record, key: &Key) -> Result<Value, String> {
    let held = get(&record.nonce)?;
    let held = held.lock().map_err(|_| REJECTED)?;
    if !held.eof || held.process.alive() {
        return Err(REJECTED.into());
    }
    let mut exit = 0;
    if unsafe { GetExitCodeProcess(held.process.handle.0, &mut exit) } == 0 {
        return Err(REJECTED.into());
    }
    if held.failed || exit != 0 {
        return Ok(
            json!({"cleared":true,"historyError":"T3_HISTORY_PROCESS_FAILED","exitCode":exit}),
        );
    }
    let mut payload = key.read("prepare", &record.admission.reservation_id)?["receipt"].clone();
    let issued = now_ms()?;
    payload["admissionDigest"] = json!(record.admission_digest);
    payload["nonce"] = json!(record.admission.nonce);
    payload["issuedAtMs"] = json!(issued);
    payload["expiresAtMs"] = json!(issued.checked_add(5000).ok_or(REJECTED)?);
    payload["historyPayloadDigest"] =
        json!(record.history_payload_digest.as_ref().ok_or(REJECTED)?);
    payload["resultDigest"] = json!(held.result_digest);
    payload["resultBytes"] = json!(held.result_bytes);
    payload["child"] = json!(held.child);
    payload["exitCode"] = json!(exit);
    payload["clearance"] = json!("service-observed-job-empty");
    let receipt = key.sign(HISTORY_RESULT_DOMAIN, &payload)?;
    Ok(json!({"cleared":true,"receipt":receipt}))
}
pub fn resume(nonce: &str) -> Result<(), String> {
    let held = get(nonce)?;
    let held = held.lock().map_err(|_| REJECTED)?;
    if held.failed || !held.process.alive() || unsafe { ResumeThread(held.thread.0) } != 1 {
        return Err(REJECTED.into());
    }
    Ok(())
}
pub fn release(nonce: &str) -> Result<(), String> {
    crate::execution_frames::release(nonce)?;
    OBSERVED.lock().map_err(|_| REJECTED)?.remove(nonce);
    Ok(())
}
pub(crate) fn expect(
    nonce: &str,
    frame: &nessie_windows_common::execution_frame::Frame,
) -> Result<(), String> {
    let held = get(nonce)?;
    let mut held = held.lock().map_err(|_| REJECTED)?;
    if held.failed {
        return Err(REJECTED.into());
    }
    if frame.driver == "codex"
        && matches!(
            frame.method.as_deref(),
            Some("thread/start" | "thread/resume")
        )
    {
        let id = frame.protocol_id.as_ref().ok_or(REJECTED)?;
        if !held
            .used_ids
            .insert(serde_json::to_string(id).map_err(|_| REJECTED)?)
        {
            return Err(REJECTED.into());
        }
    }
    if frame.driver == "claude"
        && frame.kind == "request"
        && frame.method.as_deref() == Some("initialize")
    {
        if held.initialization_written {
            return Err(REJECTED.into());
        }
        held.initialization_written = true;
    }
    Ok(())
}
pub(crate) fn automatic_reply(nonce: &str, id: &Value) -> Result<(), String> {
    let held = get(nonce)?;
    let (driver, deadline) = {
        let mut held = held.lock().map_err(|_| REJECTED)?;
        if held.failed {
            return Err(REJECTED.into());
        }
        let encoded = serde_json::to_string(id).map_err(|_| REJECTED)?;
        let (_, observed) = held.pending.remove(&encoded).ok_or(REJECTED)?;
        let deadline = observed.checked_add(5000).ok_or(REJECTED)?;
        if now_ms()? >= deadline {
            return Err(REJECTED.into());
        }
        (held.record.admission.binding.driver.clone(), deadline)
    };
    let response = if driver == "codex" {
        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Unsupported provider request"}})
    } else {
        json!({"type":"control_response","response":{"subtype":"error","request_id":id,
        "error":"Unsupported provider request"}})
    };
    let mut bytes = serde_json::to_vec(&response).map_err(|_| REJECTED)?;
    bytes.push(b'\n');
    write(nonce, bytes, deadline)
}
