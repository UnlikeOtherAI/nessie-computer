//! Signed launch only. The SYSTEM host obtains the exact descriptor from the
//! service hold, creates suspended, then transfers all provider stdin custody.
use crate::{
    execution_creator_stream, execution_spawn, execution_spawn_security::Security, protected_pipe,
};
use hmac::{Hmac, Mac};
use nessie_windows_common::{
    custody::{Operation, REJECTED},
    execution::{canonical, signing_bytes, Launch, SignedAdmission},
    execution_process::{Record, Request},
    process::Process,
    service_channel,
};
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    fs::File,
    os::windows::io::AsRawHandle,
    sync::{atomic::AtomicBool, Arc},
};
const PIN: Option<&str> = option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");
pub(crate) fn service(request: Request) -> Result<Value, String> {
    service_channel::call(
        &Operation::ExecutionProcess {
            request: Box::new(request),
        },
        PIN,
    )
}
pub fn start(
    mut file: File,
    caller: Process,
    stopped: Arc<AtomicBool>,
    graph_id: &str,
    nonce: &str,
    id: &str,
    key: &[u8; 32],
    signed: SignedAdmission,
) -> Result<(), String> {
    let admitted = service(Request::Authorize {
        graph_pid: caller.generation.pid,
        nonce: id.into(),
        admission: signed,
    })?;
    let record: Record =
        serde_json::from_value(admitted["record"].clone()).map_err(|_| REJECTED)?;
    let launch: Launch =
        serde_json::from_value(admitted["launch"].clone()).map_err(|_| REJECTED)?;
    let owner = admitted["ownerSid"].as_str().ok_or(REJECTED)?;
    let session = admitted["sessionId"]
        .as_u64()
        .ok_or(REJECTED)?
        .try_into()
        .map_err(|_| REJECTED)?;
    if record.graph != caller.generation || record.nonce != id {
        return Err(REJECTED.into());
    }
    let mut child = execution_spawn::spawn_prepared(&record, &launch, owner, session)?;
    let sid = service_channel::service_account_sid()?;
    let security = Security::new(&format!("O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;{sid})"))?;
    let (forwarded, output) = execution_spawn::pipe(&security)?;
    let registered = service(Request::Register {
        nonce: id.into(),
        child_pid: child.process.generation.pid,
        thread_handle: child.thread_handle() as usize as u64,
        stdin_handle: child.stdin.as_ref().ok_or(REJECTED)?.as_raw_handle() as usize as u64,
        stdout_handle: child.stdout.as_ref().ok_or(REJECTED)?.as_raw_handle() as usize as u64,
        output_handle: output.as_raw_handle() as usize as u64,
    })?;
    if registered["registered"] != true {
        return Err(REJECTED.into());
    }
    child.stdin.take();
    child.stdout.take();
    drop(output);
    child.stdout = Some(forwarded);
    // Only the service resumes the registered initial thread, after rechecking
    // source/release/graph and claiming the launch exactly once.
    if service(Request::Resume { nonce: id.into() })?["resumed"] != true {
        return Err(REJECTED.into());
    }
    let mut ready = json!({"kind":"ready","graphId":graph_id,"nonce":nonce,"creationId":id,
        "processPurpose":launch.process_purpose,"reservationId":record.admission.reservation_id,
        "child":child.process.generation});
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| REJECTED)?;
    mac.update(&signing_bytes(
        "nessie.t3.execution.creator-ready.v1",
        &canonical(&ready)?,
    ));
    ready["proof"] = json!(mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>());
    protected_pipe::write(&mut file, &ready).map_err(|_| REJECTED)?;
    execution_creator_stream::run_provider(file, child, id.into(), caller, stopped)
}
