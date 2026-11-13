//! Distinct fixed-role SYSTEM creator listener in the existing pinned updater.
//! No execution key, arbitrary argv or generic signing operation crosses it.
use crate::{
    execution_creator_stream, execution_spawn,
    protected_pipe::{self, Reader},
};
use hmac::{Hmac, Mac};
use nessie_windows_common::{
    custody::{Generation, Operation, REJECTED},
    execution::{canonical, signing_bytes},
    execution_creator::{CompanionRole, Request, PIPE},
    process::Process,
    release::{self, Release},
    service_channel,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    collections::BTreeMap,
    fs::File,
    io::Write,
    os::windows::io::AsRawHandle,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG},
    System::Pipes::GetNamedPipeClientProcessId,
};
const PIN: Option<&str> = option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");
const READY: &str = "nessie.t3.execution.creator-ready.v1";
#[derive(Clone)]
struct Graph {
    generation: Generation,
    key: [u8; 32],
    release_digest: String,
}
impl Drop for Graph {
    fn drop(&mut self) {
        for b in &mut self.key {
            unsafe { std::ptr::write_volatile(b, 0) }
        }
    }
}
static GRAPHS: Mutex<BTreeMap<String, Graph>> = Mutex::new(BTreeMap::new());
#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Input {
    Start {
        executor_id: String,
    },
    Companion {
        graph_id: String,
        nonce: String,
        role: CompanionRole,
    },
    Provider {
        graph_id: String,
        nonce: String,
        admission: nessie_windows_common::execution::SignedAdmission,
    },
}
fn random() -> Result<[u8; 32], String> {
    let mut value = [0u8; 32];
    if unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            value.as_mut_ptr(),
            32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    } < 0
    {
        return Err(REJECTED.into());
    }
    Ok(value)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn peer(file: &File) -> Result<Process, String> {
    let mut pid = 0;
    if unsafe { GetNamedPipeClientProcessId(file.as_raw_handle(), &mut pid) } == 0 {
        return Err(REJECTED.into());
    }
    Process::open(pid)
}
pub(crate) fn installed() -> Result<Release, String> {
    let own = Process::open(std::process::id())?;
    if own.sid != "S-1-5-18" {
        return Err(REJECTED.into());
    }
    if own.session == 0 {
        let _worker = nessie_windows_common::update_runtime::pin_image(&own.image, PIN)?;
    }
    let program = nessie_windows_common::update_admission::known_folder(
        &windows_sys::Win32::UI::Shell::FOLDERID_ProgramFiles,
    )?;
    let mut release = release::load_at(
        &program.join("Nessie Executor/nessie-executor-native.exe"),
        PIN,
    )?;
    release.verify_launch_consumers(PIN)?;
    if own.session != 0 {
        if own.image != release.runtime.native_helper {
            return Err(REJECTED.into());
        }
        nessie_windows_common::execution_isolation::verify(&own)?;
    }
    Ok(release)
}
fn service(request: Request) -> Result<Value, String> {
    service_channel::call(&Operation::ExecutionCreator { request }, PIN)
}
pub fn serve(stopped: Arc<AtomicBool>) -> Result<(), String> {
    listen(stopped, None, None)
}
fn listen(
    stopped: Arc<AtomicBool>,
    graph: Option<String>,
    ready: Option<std::sync::mpsc::Sender<()>>,
) -> Result<(), String> {
    installed()?;
    let active = Arc::new(AtomicUsize::new(0));
    let instance = |first| {
        if let Some(graph) = &graph {
            protected_pipe::execution_companion_instance(first, graph)
        } else {
            protected_pipe::instance(PIPE, first, None)
        }
    };
    let mut pending = instance(true).map_err(|_| REJECTED)?;
    if let Some(ready) = ready {
        ready.send(()).map_err(|_| REJECTED)?;
    }
    while !stopped.load(Ordering::Acquire) {
        if !protected_pipe::connect(&pending).map_err(|_| REJECTED)? {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }
        let next = instance(false).map_err(|_| REJECTED)?;
        let file = std::mem::replace(&mut pending, next);
        if active.load(Ordering::Acquire) >= 128 {
            continue;
        }
        active.fetch_add(1, Ordering::AcqRel);
        let active = active.clone();
        let stopped = stopped.clone();
        let companions = graph.is_some();
        std::thread::spawn(move || {
            let _ = connection(file, stopped, companions);
            active.fetch_sub(1, Ordering::AcqRel);
        });
    }
    Ok(())
}
fn connection(mut file: File, stopped: Arc<AtomicBool>, companions: bool) -> Result<(), String> {
    let release = installed()?;
    let caller = peer(&file)?;
    let input: Input = serde_json::from_value(
        Reader::new()
            .read(&mut file, Instant::now() + Duration::from_secs(5))
            .map_err(|_| REJECTED)?,
    )
    .map_err(|_| REJECTED)?;
    match input {
        Input::Provider {
            graph_id,
            nonce,
            admission,
        } => {
            if !companions
                || !nessie_windows_common::custody::valid_nonce(&graph_id)
                || !nessie_windows_common::custody::valid_nonce(&nonce)
            {
                return Err(REJECTED.into());
            }
            let graph = GRAPHS
                .lock()
                .map_err(|_| REJECTED)?
                .get(&graph_id)
                .cloned()
                .ok_or(REJECTED)?;
            if caller.generation != graph.generation
                || graph.release_digest != release.digest
                || !caller.alive()
            {
                return Err(REJECTED.into());
            }
            nessie_windows_common::execution_isolation::verify(&caller)?;
            crate::execution_provider::start(
                file,
                caller,
                stopped,
                &graph_id,
                &nonce,
                &hex(&random()?),
                &graph.key,
                admission,
            )
        }
        Input::Start { executor_id } => {
            if companions {
                return Err(REJECTED.into());
            }
            let id = hex(&random()?);
            let admitted = service(Request::AuthorizeGraph {
                executor_id: executor_id.clone(),
                requester_pid: caller.generation.pid,
                nonce: id.clone(),
            })?;
            crate::execution_session_host::start(file, &release, &id, admitted, caller, stopped)
        }
        Input::Companion {
            graph_id,
            nonce,
            role,
        } => {
            if !companions {
                return Err(REJECTED.into());
            }
            if !nessie_windows_common::custody::valid_nonce(&graph_id)
                || !nessie_windows_common::custody::valid_nonce(&nonce)
            {
                return Err(REJECTED.into());
            }
            let graph = GRAPHS
                .lock()
                .map_err(|_| REJECTED)?
                .get(&graph_id)
                .cloned()
                .ok_or(REJECTED)?;
            // Kernel peer binding prevents a same-user proxy from obtaining the server proof.
            if caller.generation != graph.generation
                || graph.release_digest != release.digest
                || !caller.alive()
            {
                return Err(REJECTED.into());
            }
            nessie_windows_common::execution_isolation::verify(&caller)?;
            let id = hex(&random()?);
            let admitted = service(Request::AuthorizeCompanion {
                graph_pid: caller.generation.pid,
                role: role.clone(),
                nonce: id.clone(),
            })?;
            let owner = admitted["ownerSid"].as_str().ok_or(REJECTED)?;
            let session: u32 = admitted["sessionId"]
                .as_u64()
                .ok_or(REJECTED)?
                .try_into()
                .map_err(|_| REJECTED)?;
            let child = execution_spawn::spawn(
                &release,
                owner,
                session,
                &id,
                Some(&role),
                Some(caller.generation.pid),
            )?;
            let registered = service(Request::RegisterCompanion {
                nonce: id.clone(),
                child_pid: child.process.generation.pid,
                job_name: child.job_name.clone(),
            })?;
            if registered["registered"] != true {
                return Err(REJECTED.into());
            }
            let ready = json!({"kind":"ready","graphId":graph_id,"nonce":nonce,"role":role,
                "creationId":id,"child":child.process.generation});
            let mut mac = Hmac::<Sha256>::new_from_slice(&graph.key).map_err(|_| REJECTED)?;
            mac.update(&signing_bytes(READY, &canonical(&ready)?));
            let mut response = ready;
            response["proof"] = json!(hex(&mac.finalize().into_bytes()));
            child.resume()?;
            protected_pipe::write(&mut file, &response).map_err(|_| REJECTED)?;
            execution_creator_stream::run(file, child, id, caller, stopped)
        }
    }
}

pub(crate) fn run_graph(
    mut file: File,
    release: &Release,
    id: String,
    admitted: Value,
    caller: Process,
    stopped: Arc<AtomicBool>,
) -> Result<(), String> {
    let executor_id = admitted["executorId"].as_str().ok_or(REJECTED)?.to_owned();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let listening = stopped.clone();
    let graph_id = id.clone();
    std::thread::spawn(move || {
        let _ = listen(listening, Some(graph_id), Some(ready_tx));
    });
    ready_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| REJECTED)?;
    let owner = admitted["ownerSid"].as_str().ok_or(REJECTED)?;
    let session: u32 = admitted["sessionId"]
        .as_u64()
        .ok_or(REJECTED)?
        .try_into()
        .map_err(|_| REJECTED)?;
    let mut child = execution_spawn::spawn(&release, owner, session, &id, None, None)?;
    let registered = service(Request::RegisterGraph {
        nonce: id.clone(),
        child_pid: child.process.generation.pid,
        job_name: child.job_name.clone(),
    })?;
    if registered["registered"] != true {
        return Err(REJECTED.into());
    }
    let key = random()?;
    let startup = json!({"version":1,"type":"t3.graph.start","executorId":executor_id,
                "stateDirectory":admitted["stateDirectory"],"custody":registered["custody"],
                "graphId":id,"creatorKey":hex(&key)});
    // The secret goes directly to the protected child, never the initiating daemon.
    let mut bytes = serde_json::to_vec(&startup).map_err(|_| REJECTED)?;
    bytes.push(b'\n');
    child
        .stdin
        .as_mut()
        .ok_or(REJECTED)?
        .write_all(&bytes)
        .map_err(|_| REJECTED)?;
    bytes.fill(0);
    GRAPHS.lock().map_err(|_| REJECTED)?.insert(
        id.clone(),
        Graph {
            generation: child.process.generation.clone(),
            key,
            release_digest: release.digest.clone(),
        },
    );
    let result = (|| {
        child.resume()?;
        protected_pipe::write(
            &mut file,
            &json!({"kind":"ready","child":child.process.generation}),
        )
        .map_err(|_| REJECTED)?;
        execution_creator_stream::run(file, child, id.clone(), caller, stopped)
    })();
    GRAPHS.lock().map_err(|_| REJECTED)?.remove(&id);
    result
}
