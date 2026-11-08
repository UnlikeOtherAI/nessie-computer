//! SYSTEM broker with a bounded, local-only pipe and an independent install worker.
use crate::updates::{
    channel,
    host::{self, Host},
};
use nessie_executor_updater::{
    coordinator::{Coordinator, Installer},
    network::Network,
    protocol::Request,
    storage::Store,
};
use std::{
    ffi::OsString,
    fs::File,
    io::Write,
    os::windows::{ffi::OsStrExt, io::FromRawHandle, process::CommandExt},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows_service::{
    define_windows_service,
    service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    },
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
};
use windows_sys::Win32::{
    Foundation::{
        GetLastError, LocalFree, HANDLE, ERROR_NO_DATA, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING, INVALID_HANDLE_VALUE,
    },
    Security::{
        Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SECURITY_ATTRIBUTES,
    },
    Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX},
    System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_NOWAIT, PIPE_READMODE_BYTE,
        PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES,
    },
};

const NAME: &str = "NessieExecutorUpdater";
const ERROR: &str = "update.coordinator_unavailable";
fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(Some(0))
        .collect()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
define_windows_service!(entry, service_main);
pub fn run() -> Result<(), String> {
    service_dispatcher::start(NAME, entry).map_err(|_| ERROR.into())
}

fn status(state: ServiceState) -> ServiceStatus {
    ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: if state == ServiceState::Running {
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN
        } else {
            ServiceControlAccept::empty()
        },
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::ZERO,
        process_id: None,
    }
}
fn service_main(_arguments: Vec<OsString>) {
    let stopped = Arc::new(AtomicBool::new(false));
    let requested = Arc::clone(&stopped);
    let Ok(handle) = service_control_handler::register(NAME, move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            requested.store(true, Ordering::Release);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    }) else {
        return;
    };
    let _ = handle.set_service_status(status(ServiceState::StartPending));
    // SCM points at a durable protected image. Repair does not depend on the
    // JavaScript/native payload being fully installed after an interruption.
    let outcome = host::verify_worker()
        .and_then(|()| nessie_windows_common::peer_inspection::allow_verification()
            .map_err(|_| "update.peer_inspection_unavailable"))
        .and_then(|()| {
            // Source consent uses its own typed listener and never widens update control.
            let issuer_stopped = stopped.clone();
            std::thread::spawn(move || { let _ = crate::t3_source::issuer_service::serve(issuer_stopped); });
            let _ = handle.set_service_status(status(ServiceState::Running));
            serve(stopped.clone()).map_err(|_| ERROR)
        });
    stopped.store(true, Ordering::Release);
    let mut final_status = status(ServiceState::Stopped);
    if outcome.is_err() {
        final_status.exit_code = ServiceExitCode::Win32(1);
    }
    let _ = handle.set_service_status(final_status);
}

fn instance(first: bool) -> Result<File, String> {
    // Client access excludes FILE_CREATE_PIPE_INSTANCE (FILE_APPEND_DATA).
    let sddl = wide("O:SYG:SYD:P(A;;FA;;;SY)(A;;0x0012018B;;;AU)");
    let mut descriptor = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(ERROR.into());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let pipe = unsafe {
        CreateNamedPipeW(
            wide(channel::PIPE).as_ptr(),
            PIPE_ACCESS_DUPLEX
                | if first {
                    FILE_FLAG_FIRST_PIPE_INSTANCE
                } else {
                    0
                },
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            32_768,
            32_768,
            5_000,
            &attributes,
        )
    };
    unsafe { LocalFree(descriptor) };
    if pipe.is_null() || pipe == INVALID_HANDLE_VALUE {
        return Err(ERROR.into());
    }
    Ok(unsafe { File::from_raw_handle(pipe.cast()) })
}

#[derive(Debug, PartialEq, Eq)]
enum Accept { Listening, Connected, Abandoned }

fn accept_state(pipe: HANDLE) -> Result<Accept, String> {
    let connected = unsafe { ConnectNamedPipe(pipe, std::ptr::null_mut()) };
    if connected != 0 {
        // For PIPE_NOWAIT, success makes a disconnected instance available.
        // Only ERROR_PIPE_CONNECTED proves that a client has connected.
        return Ok(Accept::Listening);
    }
    match unsafe { GetLastError() } {
        ERROR_PIPE_CONNECTED => Ok(Accept::Connected),
        ERROR_PIPE_LISTENING => Ok(Accept::Listening),
        ERROR_NO_DATA => Ok(Accept::Abandoned),
        _ => Err(ERROR.into()),
    }
}

fn serve(stopped: Arc<AtomicBool>) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    let active = Arc::new(AtomicUsize::new(0));
    let mut worker: Option<Child> = None;
    let mut first = true;
    'accept: while !stopped.load(Ordering::Acquire) {
        if worker
            .as_mut()
            .is_none_or(|child| child.try_wait().ok().flatten().is_some())
        {
            worker = spawn_worker().ok();
        }
        let file = instance(first)?;
        first = false;
        let mut next_worker_check = Instant::now() + Duration::from_secs(3);
        loop {
            if stopped.load(Ordering::Acquire) {
                return Ok(());
            }
            if Instant::now() >= next_worker_check {
                if worker
                    .as_mut()
                    .is_none_or(|child| child.try_wait().ok().flatten().is_some())
                {
                    worker = spawn_worker().ok();
                }
                next_worker_check = Instant::now() + Duration::from_secs(3);
            }
            match accept_state(file.as_raw_handle().cast())? {
                Accept::Connected => break,
                Accept::Abandoned => continue 'accept,
                Accept::Listening => std::thread::sleep(Duration::from_millis(50)),
            }
        }
        if active.load(Ordering::Acquire) >= 16 {
            continue;
        }
        active.fetch_add(1, Ordering::AcqRel);
        let count = Arc::clone(&active);
        std::thread::spawn(move || {
            let _ = connection(file);
            count.fetch_sub(1, Ordering::AcqRel);
        });
    }
    Ok(())
}

fn connection(mut file: File) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 1024];
    loop {
        if bytes.len() > 16_384 || Instant::now() >= deadline {
            return Err(ERROR.into());
        }
        match nessie_windows_common::pipe_io::read(&file, &mut buffer) {
            Ok(0) => return Err(ERROR.into()),
            Ok(count) => {
                bytes.extend_from_slice(&buffer[..count]);
                if bytes.ends_with(b"\n") {
                    break;
                }
            }
            Err(error) if error.raw_os_error() == Some(232) => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(_) => return Err(ERROR.into()),
        }
    }
    if bytes.len() > 16_384 {
        return Err(ERROR.into());
    }
    let response = serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|_| ERROR.to_owned())
        .and_then(|value| {
            if value == serde_json::json!({"operation":"app_ready"}) {
                let store = Store::new(host::root().map_err(str::to_owned)?);
                let network = Network::default();
                let installer = Host;
                let status = Coordinator { store: &store, network: &network, installer: &installer }
                    .status(now()).map_err(str::to_owned)?;
                return host::platform::prepare_exit(file.as_raw_handle().cast(),
                    status.draining && status.phase == nessie_executor_updater::protocol::Phase::Waiting)
                    .map(|allowed| serde_json::json!({"mayExit":allowed})).map_err(str::to_owned);
            }
            let request = serde_json::from_value::<Request>(value).map_err(|_| ERROR.to_owned())?;
            if matches!(request, Request::Status) {
                // Failure is ordinary for a CLI or an older runtime; it grants no
                // health authority and never makes a status read fail.
                let _ = host::platform::observe_daemon(file.as_raw_handle().cast());
            }
            let store = Store::new(host::root().map_err(str::to_owned)?);
            let network = Network::default();
            let installer = Host;
            let coordinator = Coordinator {
                store: &store,
                network: &network,
                installer: &installer,
            };
            coordinator
                .control(request, now())
                .map(|status| serde_json::to_value(status).unwrap())
                .map_err(str::to_owned)
        });
    let value = response.unwrap_or_else(|code| serde_json::json!({"error":code}));
    let mut response = serde_json::to_vec(&value).map_err(|_| ERROR)?;
    response.push(b'\n');
    file.write_all(&response).map_err(|_| ERROR)?;
    // Wait for the reader to consume the bounded answer before disconnecting;
    // closing a named pipe early discards unread output. A client ACK closes it.
    while Instant::now() < deadline {
        match nessie_windows_common::pipe_io::read(&file, &mut buffer) {
            Ok(0) => break,
            Ok(_) => break,
            Err(error) if error.raw_os_error() == Some(232) => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(_) => break,
        }
    }
    unsafe { DisconnectNamedPipe(file.as_raw_handle().cast()) };
    Ok(())
}

// Resolve these in the verified SCM context before discarding inherited values.
fn worker_environment(command: &mut Command) -> Result<(), String> {
    use nessie_windows_common::update_admission::known_folder;
    use windows_sys::Win32::UI::Shell::{FOLDERID_ProgramData, FOLDERID_Windows};
    let windows = known_folder(&FOLDERID_Windows)?;
    let data = known_folder(&FOLDERID_ProgramData)?;
    let drive = windows.components().next().ok_or(ERROR)?.as_os_str().to_owned();
    command.env_clear().env("SystemRoot", windows).env("SystemDrive", drive)
        .env("ALLUSERSPROFILE", &data).env("ProgramData", data);
    Ok(())
}

fn spawn_worker() -> Result<Child, String> {
    let store = Store::new(host::root().map_err(str::to_owned)?);
    if !store.installation_enabled().map_err(str::to_owned)? { return Err("update.installation_removed".into()); }
    // Kernel-owned lease recovery also covers a worker surviving an MSI's SCM stop.
    let lease = store.runner().map_err(str::to_owned)?;
    drop(lease);
    let executable = host::worker_image().map_err(str::to_owned)?;
    let mut command = Command::new(executable);
    worker_environment(&mut command)?;
    command.arg("update-worker")
        .current_dir(host::root().map_err(str::to_owned)?)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0000_0200 | 0x0800_0000)
        .spawn()
        .map_err(|_| ERROR.into())
}

pub fn worker() -> Result<(), String> {
    host::verify_worker().map_err(str::to_owned)?;
    let store = Store::new(host::root().map_err(str::to_owned)?);
    let _runner = store.runner().map_err(str::to_owned)?;
    if !store.installation_enabled().map_err(str::to_owned)? { return Ok(()); }
    store
        .mutate_journal(|journal| {
            journal.check_requested_at = Some(now());
            Ok(())
        })
        .map_err(str::to_owned)?;
    let network = Network::default();
    let installer = Host;
    let coordinator = Coordinator {
        store: &store,
        network: &network,
        installer: &installer,
    };
    loop {
        if !store.installation_enabled().map_err(str::to_owned)? { return Ok(()); }
        coordinator.tick(now()).map_err(str::to_owned)?;
        if store.journal().map_err(str::to_owned)?.pending.is_none()
            && installer.installed().map_err(str::to_owned)?.source_commit
                != env!("NESSIE_EXECUTOR_SOURCE_COMMIT")
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}

#[cfg(test)]
mod pipe_tests {
    use super::*;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING},
    };

    #[test]
    fn nonblocking_listen_success_is_not_an_accepted_client() {
        let name = wide(&format!(r"\\.\pipe\NessieUpdaterAcceptTest-{}", std::process::id()));
        let pipe = unsafe { CreateNamedPipeW(name.as_ptr(), PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1, 4096, 4096, 0, std::ptr::null()) };
        assert_ne!(pipe, INVALID_HANDLE_VALUE);
        struct Owned(HANDLE);
        impl Drop for Owned { fn drop(&mut self) { unsafe { CloseHandle(self.0) }; } }
        let server = Owned(pipe);
        assert_eq!(accept_state(server.0).unwrap(), Accept::Listening);
        assert_eq!(accept_state(server.0).unwrap(), Accept::Listening);
        let client = unsafe { CreateFileW(name.as_ptr(), nessie_windows_common::CONTROL_PIPE_CLIENT_ACCESS,
            0, std::ptr::null(), OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, std::ptr::null_mut()) };
        assert_ne!(client, INVALID_HANDLE_VALUE);
        let client = Owned(client);
        assert_eq!(accept_state(server.0).unwrap(), Accept::Connected);
        drop(client);
        assert_eq!(accept_state(server.0).unwrap(), Accept::Abandoned);
    }

    #[test]
    fn worker_environment_resolves_the_same_machine_state_root() {
        use nessie_windows_common::update_admission::{known_folder, root};
        use windows_sys::Win32::UI::Shell::{FOLDERID_ProgramData, FOLDERID_ProgramFiles, FOLDERID_Windows};
        const CHILD: &str = "NESSIE_WINDOWS_WORKER_ENV_TEST";
        if let Some(expected) = std::env::var_os(CHILD) {
            let data = known_folder(&FOLDERID_ProgramData).unwrap();
            assert_eq!(data, std::path::PathBuf::from(expected));
            assert_eq!(root().unwrap(), data.join("Nessie Executor Updates"));
            assert!(known_folder(&FOLDERID_ProgramFiles).unwrap().is_absolute());
            assert!(known_folder(&FOLDERID_Windows).unwrap().is_absolute());
            println!("worker-known-folders-verified");
            return;
        }
        let data = known_folder(&FOLDERID_ProgramData).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap());
        worker_environment(&mut child).unwrap();
        let module = module_path!().split_once("::").unwrap().1;
        let output = child.args(["--exact", &format!("{module}::worker_environment_resolves_the_same_machine_state_root"), "--nocapture"])
            .env(CHILD, data).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains("worker-known-folders-verified"));
    }
}
