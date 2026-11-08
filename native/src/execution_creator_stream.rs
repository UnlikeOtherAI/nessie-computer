//! Bounded, backpressured companion bytes. Written ACK follows the actual child
//! pipe write. Lost ACK is unknown delivery and is never retransmitted.
use crate::{
    execution_spawn::Child,
    protected_pipe::{self, Reader},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use nessie_windows_common::{
    custody::{Operation, REJECTED},
    execution_creator::Request,
    process::Process,
    service_channel,
};
use serde_json::json;
use std::{
    fs::File,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
const PIN: Option<&str> = option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");
fn send(output: &Arc<Mutex<File>>, value: &serde_json::Value) -> Result<(), String> {
    let mut guard = output.lock().map_err(|_| REJECTED)?;
    protected_pipe::write(&mut guard, value).map_err(|_| REJECTED.into())
}
pub fn run(
    file: File,
    child: Child,
    nonce: String,
    requester: Process,
    stopped: Arc<AtomicBool>,
) -> Result<(), String> {
    run_inner(file, child, nonce, requester, stopped, false)
}
pub fn run_provider(
    file: File,
    child: Child,
    nonce: String,
    requester: Process,
    stopped: Arc<AtomicBool>,
) -> Result<(), String> {
    run_inner(file, child, nonce, requester, stopped, true)
}
fn run_inner(
    mut file: File,
    mut child: Child,
    nonce: String,
    requester: Process,
    stopped: Arc<AtomicBool>,
    provider: bool,
) -> Result<(), String> {
    let output = Arc::new(Mutex::new(file.try_clone().map_err(|_| REJECTED)?));
    let failed = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let writing = Arc::new(AtomicU64::new(0));
    let started = Instant::now();
    let watchdog = {
        let job = child.duplicate_job()?;
        let watch = file.try_clone().map_err(|_| REJECTED)?;
        let caller = Process::open(requester.generation.pid)?;
        let stopped = stopped.clone();
        let failed = failed.clone();
        let done = done.clone();
        let writing = writing.clone();
        std::thread::spawn(move || {
            // Move the owning Send wrapper, keeping its handle alive until the
            // watchdog exits instead of capturing only its raw pointer field.
            let owned_job = job;
            while !done.load(Ordering::Acquire) {
                let pending = writing.load(Ordering::Acquire);
                if stopped.load(Ordering::Acquire)
                    || failed.load(Ordering::Acquire)
                    || !caller.alive()
                    || !protected_pipe::alive(&watch)
                    || (pending > 0 && started.elapsed().as_millis() as u64 > pending + 5000)
                {
                    unsafe {
                        windows_sys::Win32::System::JobObjects::TerminateJobObject(owned_job.0, 125)
                    };
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        })
    };
    let mut readers = Vec::new();
    for (kind, mut pipe) in [
        ("stdout", child.stdout.take().ok_or(REJECTED)?),
        ("stderr", child.stderr.take().ok_or(REJECTED)?),
    ] {
        let output = output.clone();
        let failed = failed.clone();
        readers.push(std::thread::spawn(move || {
            let mut bytes = [0u8; 16384];
            loop {
                match pipe.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(n) => {
                        if send(
                            &output,
                            &json!({"kind":kind,"data":STANDARD.encode(&bytes[..n])}),
                        )
                        .is_err()
                        {
                            failed.store(true, Ordering::Release);
                            break;
                        }
                    }
                    Err(_) => {
                        failed.store(true, Ordering::Release);
                        break;
                    }
                }
            }
        }));
    }
    let mut reader = Reader::new();
    let mut sequence = 0u64;
    let result = (|| -> Result<(), String> {
        loop {
            if stopped.load(Ordering::Acquire)
                || failed.load(Ordering::Acquire)
                || !requester.alive()
            {
                break;
            }
            if let Some(code) = child.exit_code()? {
                send(&output, &json!({"kind":"exit","code":code}))?;
                break;
            }
            if let Some(value) = reader.poll(&mut file).map_err(|_| REJECTED)? {
                match value["kind"].as_str() {
                    Some("stdin") => {
                        if provider {
                            return Err(REJECTED.into());
                        }
                        if value.as_object().is_none_or(|v| v.len() != 3)
                            || value["sequence"].as_u64() != Some(sequence + 1)
                        {
                            return Err(REJECTED.into());
                        }
                        let encoded = value["data"].as_str().ok_or(REJECTED)?;
                        if encoded.len() > 24000 {
                            return Err(REJECTED.into());
                        }
                        let bytes = STANDARD.decode(encoded).map_err(|_| REJECTED)?;
                        if STANDARD.encode(&bytes) != encoded {
                            return Err(REJECTED.into());
                        }
                        writing.store(started.elapsed().as_millis() as u64 + 1, Ordering::Release);
                        child
                            .stdin
                            .as_mut()
                            .ok_or(REJECTED)?
                            .write_all(&bytes)
                            .map_err(|_| REJECTED)?;
                        writing.store(0, Ordering::Release);
                        sequence += 1;
                        send(&output, &json!({"kind":"written","sequence":sequence}))?;
                    }
                    Some("stdinEnd") => {
                        if provider {
                            crate::execution_provider::service(
                                nessie_windows_common::execution_process::Request::End {
                                    nonce: nonce.clone(),
                                },
                            )?;
                        } else {
                            child.stdin.take();
                        }
                        send(&output, &json!({"kind":"inputEnded"}))?;
                    }
                    Some("stop") => break,
                    _ => return Err(REJECTED.into()),
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    })();
    let stop = child.stop();
    child.stdin.take();
    done.store(true, Ordering::Release);
    watchdog.join().map_err(|_| REJECTED)?;
    stop?;
    // Service observes the exact job independently; no exit/kill boolean is clearance.
    let mut cleared = false;
    let mut completion = serde_json::Value::Null;
    for _ in 0..100 {
        let result = if provider {
            crate::execution_provider::service(
                nessie_windows_common::execution_process::Request::Clear {
                    nonce: nonce.clone(),
                },
            )
        } else {
            service_channel::call(
                &Operation::ExecutionCreator {
                    request: Request::Clear {
                        nonce: nonce.clone(),
                    },
                },
                PIN,
            )
        };
        if let Ok(value) = result {
            if value["cleared"] == true {
                completion = value;
                cleared = true;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if !cleared {
        return Err(REJECTED.into());
    }
    // Each output writer has a bounded write deadline. Preserve byte order before closed.
    for reader in readers {
        reader.join().map_err(|_| REJECTED)?;
    }
    if result.is_err() || failed.load(Ordering::Acquire) {
        send(
            &output,
            &json!({"kind":"error","code":"T3_NATIVE_DELIVERY_UNKNOWN"}),
        )?;
    }
    send(
        &output,
        &json!({"kind":"closed","cleared":true,"completion":completion}),
    )
}
