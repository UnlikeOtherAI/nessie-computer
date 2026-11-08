//! The service owns the only provider stdout reader and forwards unchanged bytes.
//! No nativeId field exists on the attachment request.
use crate::{
    execution::image_digest,
    execution_key::{sha, Key},
};
use nessie_windows_common::{
    custody::{Generation, REJECTED},
    custody_observation::job_members,
    execution::{now_ms, Admission, Descriptor},
    process::{self, Owned, Process},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Write},
    os::windows::io::FromRawHandle,
    sync::{Arc, Mutex},
};
use windows_sys::Win32::{
    Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE},
    Storage::FileSystem::{GetFileType, FILE_TYPE_PIPE},
    System::Threading::{GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE},
};
struct Observation {
    descriptor: Descriptor,
    provider: Generation,
    provider_image_digest: String,
    provider_session_id: String,
    launch_digest: String,
    frame: Option<Value>,
    failed: bool,
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
    let file = unsafe { File::from_raw_handle(copy.cast()) };
    if unsafe { GetFileType(copy) } != FILE_TYPE_PIPE {
        return Err(REJECTED.into());
    }
    Ok(file)
}
pub fn attach(
    caller: &Process,
    descriptor: &Descriptor,
    key: &Key,
    id: &str,
    child_pid: u32,
    stdout: u64,
    output: u64,
    provider_session_id: String,
) -> Result<(), String> {
    let launch = key.read("launch", id)?;
    let admission: Admission =
        serde_json::from_value(launch["admission"].clone()).map_err(|_| REJECTED)?;
    admission.validate(now_ms()?)?;
    if launch["prepared"]["receipt"]["providerSessionId"] != provider_session_id {
        return Err(REJECTED.into());
    }
    if launch["controller"] != serde_json::to_value(&caller.generation).map_err(|_| REJECTED)? {
        return Err(REJECTED.into());
    }
    let parent = process::snapshot()?
        .into_iter()
        .find(|p| p.pid == child_pid)
        .ok_or(REJECTED)?
        .parent;
    let child = Process::open(child_pid)?;
    if parent != caller.generation.pid
        || !child.alive()
        || child.sid != caller.sid
        || child.session != caller.session
        || child.image.to_str() != launch["prepared"]["command"].as_str()
        || !job_members(&descriptor.custody.job_name)?.contains(&child_pid)
    {
        return Err(REJECTED.into());
    }
    let image = image_digest(File::open(&child.image).map_err(|_| REJECTED)?)?;
    if launch["prepared"]["providerImageDigest"] != image {
        return Err(REJECTED.into());
    }
    let native = Owned(unsafe { OpenProcess(PROCESS_DUP_HANDLE, 0, caller.generation.pid) });
    if native.0.is_null() {
        return Err(REJECTED.into());
    }
    let mut reader = duplicate(native.0, stdout)?;
    let mut writer = duplicate(native.0, output)?;
    let observation = Arc::new(Mutex::new(Observation {
        descriptor: descriptor.clone(),
        provider: child.generation,
        provider_image_digest: image,
        provider_session_id,
        launch_digest: admission.launch_digest.ok_or(REJECTED)?,
        frame: None,
        failed: false,
    }));
    let mut all = OBSERVED.lock().map_err(|_| REJECTED)?;
    all.retain(|_, value| {
        value
            .lock()
            .map(|value| {
                !nessie_windows_common::custody_observation::absent(&value.provider)
                    .unwrap_or(false)
            })
            .unwrap_or(true)
    });
    if all.len() >= 256 || all.contains_key(id) {
        return Err(REJECTED.into());
    }
    all.insert(id.to_owned(), observation.clone());
    drop(all);
    let driver = admission.binding.driver;
    std::thread::spawn(move || {
        let mut chunk = [0u8; 65536];
        let mut frame = Vec::new();
        let mut usable = true;
        let outcome = (|| -> std::io::Result<()> {
            loop {
                let count = reader.read(&mut chunk)?;
                if count == 0 {
                    return Ok(());
                }
                if usable {
                    for byte in &chunk[..count] {
                        frame.push(*byte);
                        if frame.len() > 131072 {
                            usable = false;
                            break;
                        }
                        if *byte == b'\n' {
                            if let Some(found) = native_identity(&driver, &frame) {
                                let mut held =
                                    observation.lock().map_err(|_| std::io::ErrorKind::Other)?;
                                if held.frame.is_some() {
                                    held.failed = true;
                                } else {
                                    held.frame = Some(found);
                                }
                            }
                            frame.clear();
                        }
                    }
                }
                writer.write_all(&chunk[..count])?;
                writer.flush()?;
            }
        })();
        if let Ok(mut held) = observation.lock() {
            held.failed |= outcome.is_err() || !usable || !frame.is_empty();
        }
    });
    Ok(())
}
fn native_identity(driver: &str, bytes: &[u8]) -> Option<Value> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let (id, message) = match driver {
        "codex" if value.get("error").is_none() => {
            let id = value.get("result")?.get("thread")?.get("id")?.as_str()?;
            let message = match &value["id"] {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => return None,
            };
            (id, message)
        }
        "claude" if value["type"] == "system" && value["subtype"] == "init" => (
            value["session_id"].as_str()?,
            value["uuid"].as_str()?.to_owned(),
        ),
        _ => return None,
    };
    if !nessie_windows_common::execution::identifier(id)
        || !nessie_windows_common::execution::identifier(&message)
    {
        return None;
    }
    Some(
        json!({"nativeId":id,"observation":{"kind":"service-held-provider-stdout",
        "frameDigest":sha(bytes),"requestId":message,"observedAtMs":now_ms().ok()?}}),
    )
}
pub fn consume(id: &str, admission: &Admission, descriptor: &Descriptor) -> Result<Value, String> {
    let observed = OBSERVED
        .lock()
        .map_err(|_| REJECTED)?
        .get(id)
        .cloned()
        .ok_or(REJECTED)?;
    let held = observed.lock().map_err(|_| REJECTED)?;
    let current = Process::open(held.provider.pid)?;
    if held.failed
        || held.descriptor != *descriptor
        || !current.alive()
        || current.generation != held.provider
        || !job_members(&descriptor.custody.job_name)?.contains(&held.provider.pid)
        || admission.provider_session_id.as_deref() != Some(held.provider_session_id.as_str())
        || admission.launch_digest.as_deref() != Some(held.launch_digest.as_str())
    {
        return Err(REJECTED.into());
    }
    let mut frame = held.frame.clone().ok_or(REJECTED)?;
    frame["provider"] = serde_json::to_value(&held.provider).map_err(|_| REJECTED)?;
    frame["providerImageDigest"] = json!(held.provider_image_digest);
    Ok(frame)
}
