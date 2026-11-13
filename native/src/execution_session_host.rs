//! Same-session SYSTEM host and updater proxy. The bootstrap connection has no
//! effect authority; only the service's recorded creation nonce admits a host.
use crate::{
    execution_creator_listener, execution_session_process,
    protected_pipe::{self, Reader},
    protocol::NativeError,
};
use nessie_windows_common::{
    custody::{Operation, REJECTED},
    execution_creator::Request,
    process::{self, Process},
    release::Release,
    service_channel,
};
use serde_json::Value;
use std::{
    fs::File,
    os::windows::io::AsRawHandle,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
const PIN: Option<&str> = option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");
fn name(nonce: &str) -> String {
    format!(r"\\.\pipe\NessieT3ExecutionSession-{nonce}")
}
fn service(request: Request) -> Result<Value, String> {
    service_channel::call(&Operation::ExecutionCreator { request }, PIN)
}
pub fn start(
    mut client: File,
    release: &Release,
    id: &str,
    admitted: Value,
    requester: Process,
    stopped: Arc<AtomicBool>,
) -> Result<(), String> {
    let session: u32 = admitted["sessionId"]
        .as_u64()
        .ok_or(REJECTED)?
        .try_into()
        .map_err(|_| REJECTED)?;
    let host = execution_session_process::spawn(release, session, id)?;
    if service(Request::RegisterSessionHost {
        nonce: id.into(),
        child_pid: host.process.generation.pid,
        job_name: host.job_name.clone(),
    })?["registered"]
        != true
    {
        return Err(REJECTED.into());
    }
    host.resume()?;
    // Connection retries precede all graph creation. A connected request is
    // never resent and an uncertain result never creates a second graph.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut pipe = loop {
        if !host.process.alive()
            || !requester.alive()
            || stopped.load(Ordering::Acquire)
            || Instant::now() >= deadline
        {
            return Err(REJECTED.into());
        }
        match protected_pipe::client_process(&name(id), &host.process.generation) {
            Ok(file) => break file,
            Err(_) => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    let mut from_client = Reader::new();
    let mut from_host = Reader::new();
    loop {
        if stopped.load(Ordering::Acquire) || !requester.alive() || !protected_pipe::alive(&client)
        {
            return Err(REJECTED.into());
        }
        if let Some(frame) = from_client.poll(&mut client).map_err(|_| REJECTED)? {
            protected_pipe::write(&mut pipe, &frame).map_err(|_| REJECTED)?;
        }
        if let Some(frame) = from_host.poll(&mut pipe).map_err(|_| REJECTED)? {
            if frame["kind"] == "closed" && frame["cleared"] == true {
                host.stop();
                let deadline = Instant::now() + Duration::from_secs(2);
                loop {
                    if service(Request::ClearSessionHost { nonce: id.into() })
                        .is_ok_and(|v| v["cleared"] == true)
                    {
                        break;
                    }
                    if Instant::now() >= deadline {
                        return Err(REJECTED.into());
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                return protected_pipe::write(&mut client, &frame).map_err(|_| REJECTED.into());
            }
            protected_pipe::write(&mut client, &frame).map_err(|_| REJECTED)?;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
pub fn run(id: &str) -> Result<(), NativeError> {
    run_inner(id).map_err(|_| NativeError::new("EXECUTOR_T3_SESSION_HOST_REFUSED"))
}
fn run_inner(id: &str) -> Result<(), String> {
    if !nessie_windows_common::custody::valid_nonce(id) {
        return Err(REJECTED.into());
    }
    let own = Process::open(std::process::id())?;
    if own.sid != "S-1-5-18" || own.session == 0 {
        return Err(REJECTED.into());
    }
    let release = execution_creator_listener::installed()?;
    let parent_id = process::snapshot()?
        .into_iter()
        .find(|p| p.pid == own.generation.pid)
        .ok_or(REJECTED)?
        .parent;
    let parent = Process::open(parent_id)?;
    if parent.sid != "S-1-5-18" || parent.session != 0 || !parent.alive() {
        return Err(REJECTED.into());
    }
    let _parent_image = nessie_windows_common::update_runtime::pin_image(&parent.image, PIN)?;
    let admitted = service(Request::SessionContext { nonce: id.into() })?;
    let pipe = protected_pipe::instance(&name(id), true, Some("S-1-5-18")).map_err(|_| REJECTED)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if !parent.alive() || Instant::now() >= deadline {
            return Err(REJECTED.into());
        }
        if protected_pipe::connect(&pipe).map_err(|_| REJECTED)? {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut peer = 0;
    if unsafe {
        windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId(
            pipe.as_raw_handle(),
            &mut peer,
        )
    } == 0
        || peer != parent.generation.pid
    {
        return Err(REJECTED.into());
    }
    let actual = Process::open(peer)?;
    if actual.generation != parent.generation {
        return Err(REJECTED.into());
    }
    let stopped = Arc::new(AtomicBool::new(false));
    let result = execution_creator_listener::run_graph(
        pipe,
        &release,
        id.into(),
        admitted,
        parent,
        stopped.clone(),
    );
    stopped.store(true, Ordering::Release);
    result
}
