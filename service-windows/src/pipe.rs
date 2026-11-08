//! Separate pairing-control and runtime-admission channels, one JSON object per line.
//!
//! Each accepted connection is served on its own short-lived thread, and a fresh
//! instance is created immediately, so a client that connects and then says
//! nothing cannot wedge the service or lock out the tray. Every instance is
//! created with a descriptor built from the accounts recorded *at that moment*,
//! which is how an elevated grant takes effect without restarting the service.

use std::{
    io::{BufRead, BufReader, Read, Write},
    mem::ManuallyDrop,
    os::windows::{ffi::OsStrExt, io::FromRawHandle},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FlushFileBuffers, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};

use crate::{
    control::Control,
    log::log_line,
    paths::{control_client_sids, control_clients_root},
    protocol::{parse_request, Command, Response, MAX_REQUEST_BYTES},
    security::{connected_client_identity, current_user_sid_string, PipeSecurity, CLIENT_ACCESS},
};

pub const PIPE_NAME: &str = r"\\.\pipe\NessieExecutor";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    Control,
    Custody,
}
impl Scope {
    fn name(self) -> &'static str {
        match self {
            Self::Control => PIPE_NAME,
            Self::Custody => nessie_windows_common::CUSTODY_PIPE_NAME,
        }
    }
    fn allows(self, command: &Command) -> bool {
        self == Self::Control || matches!(command, Command::ManagedCustody { .. })
    }
}

/// Big enough for the largest request the protocol accepts plus its answer, so
/// a control call never blocks on the transport itself.
const PIPE_BUFFER_BYTES: u32 = 128 * 1024;

/// The default time a client waits for an instance, in milliseconds. Only
/// applies to a client that asks Windows to wait.
const PIPE_DEFAULT_TIMEOUT_MS: u32 = 5_000;

fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// The accounts every instance admits: those recorded under the service root,
/// plus the service's own account so the stop path can unblock its own accept.
fn admitted_sids(root: &Path) -> Vec<String> {
    let mut sids = control_client_sids(root);
    sids.sort();
    sids.dedup();
    sids
}

fn create_instance(root: &Path, scope: Scope) -> Result<HANDLE, String> {
    let own = current_user_sid_string()
        .map_err(|_| "Windows would not report the Nessie Computer account.".to_owned())?;
    let mut security = match scope {
        Scope::Control => PipeSecurity::new(&admitted_sids(root), &own)?,
        Scope::Custody => PipeSecurity::custody(&own)?,
    };
    let attributes = security.attributes();
    let handle = unsafe {
        CreateNamedPipeW(
            wide(scope.name()).as_ptr(),
            PIPE_ACCESS_DUPLEX,
            // Byte mode with blocking reads, and never over the network: a DACL
            // alone would still admit a domain account remotely.
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            PIPE_BUFFER_BYTES,
            PIPE_BUFFER_BYTES,
            PIPE_DEFAULT_TIMEOUT_MS,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return Err("Nessie Computer could not open its control channel.".to_owned());
    }
    Ok(handle)
}

/// Reads one request line and writes one answer. The handle is closed here, and
/// only here: `ManuallyDrop` keeps the `File` wrapper from closing it early,
/// because a pipe must be flushed and disconnected first or the client can lose
/// the answer it is still reading.
fn serve_connection(handle: HANDLE, root: &Path, control: &Control, scope: Scope) {
    let file = ManuallyDrop::new(unsafe { std::fs::File::from_raw_handle(handle as *mut _) });
    let mut line = String::new();
    let response = {
        let mut reader = BufReader::new((&*file).take(MAX_REQUEST_BYTES as u64 + 1));
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => {
                // Windows can impersonate only after it has received a client
                // message. Reading the line first makes this identity an
                // authenticated fact rather than a best-effort pre-read.
                let client = connected_client_identity(handle);
                Some(match parse_request(line.trim_end_matches(['\r', '\n'])) {
                    Ok(command) if !scope.allows(&command) => {
                        Response::error("This channel accepts runtime admission only.")
                    }
                    Ok(Command::ManagedCustody { operation }) => {
                        if control.supervisor().is_none() {
                            control.handle(Command::Status, None)
                        } else {
                            match crate::custody::handle(
                                handle,
                                root,
                                client.as_ref().map(|value| value.sid.as_str()),
                                operation,
                            ) {
                                Ok(custody) => Response::ManagedCustody { custody },
                                Err(reason) => Response::error(reason),
                            }
                        }
                    }
                    Ok(Command::EnrollControlClient) => {
                        let owner = enrollment_owner(handle, client.as_ref()).ok();
                        enroll_control_client(root, control, client, owner.as_deref())
                    }
                    Ok(command) => control.handle(
                        command,
                        client.as_ref().map(|identity| identity.sid.as_str()),
                    ),
                    Err(reason) => Response::error(reason),
                })
            }
        }
    };
    if let Some(response) = response {
        let mut writer = &*file;
        let _ = writer.write_all(response.encode().as_bytes());
        let _ = writer.flush();
    }
    unsafe {
        FlushFileBuffers(handle);
        DisconnectNamedPipe(handle);
        CloseHandle(handle);
    }
}

/// The state root deliberately admits only the service and SYSTEM. An
/// administrator therefore cannot create a marker in it even after UAC; this
/// command crosses the already administrator-gated pipe so the service writes
/// the marker itself. Enrollment derives the owner SID from the signed elevated
/// tray's actual active login session, never a request field. UAC approval by another administrator does not make that administrator
/// the pairing owner; the ordinary tray starts pairing after enrollment.
fn enrollment_owner(
    handle: HANDLE,
    client: Option<&crate::security::ConnectedClient>,
) -> Result<String, String> {
    use nessie_windows_common::{
        custody::REJECTED,
        process::{session_owner, Process},
    };
    use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
    let client = client
        .filter(|client| client.is_administrator)
        .ok_or(REJECTED)?;
    let mut pid = 0;
    if unsafe { GetNamedPipeClientProcessId(handle, &mut pid) } == 0 {
        return Err(REJECTED.into());
    }
    let process = Process::open(pid)?;
    if process.sid != client.sid
        || !process.elevated
        || !process.alive()
        || !process
            .image
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("nessie-executor-tray.exe"))
    {
        return Err(REJECTED.into());
    }
    process.signed(option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"))?;
    let owner = session_owner(process.session)?;
    if !process.alive() {
        return Err(REJECTED.into());
    }
    Ok(owner)
}

fn enroll_control_client(
    root: &Path,
    control: &Control,
    client: Option<crate::security::ConnectedClient>,
    observed_session_owner: Option<&str>,
) -> Response {
    if control.supervisor().is_none() {
        return control.handle(Command::Status, None);
    }
    let Some(_client) = client.filter(|identity| identity.is_administrator) else {
        return Response::error("An administrator must approve control access for this account.");
    };
    let directory = control_clients_root(root);
    let Some(sid) = observed_session_owner.filter(|sid| nessie_windows_common::is_sid_string(sid))
    else {
        return Response::error(
            "Windows could not verify the signed-in account approved for this connection.",
        );
    };
    match std::fs::create_dir_all(&directory)
        .and_then(|()| std::fs::write(directory.join(&sid), b""))
    {
        Ok(()) => control.handle(Command::Status, Some(sid)),
        Err(_) => Response::error("Nessie Computer could not record this account."),
    }
}

/// Unblocks a pending `ConnectNamedPipe` by connecting to it. The service's own
/// account is admitted for exactly this, so a stop never waits on whether anyone
/// happens to call.
pub fn poke() {
    for scope in [Scope::Control, Scope::Custody] {
        poke_channel(scope);
    }
}

fn poke_channel(scope: Scope) {
    let handle = unsafe {
        CreateFileW(
            wide(scope.name()).as_ptr(),
            // Use exactly the rights the pipe DACL grants. `GENERIC_WRITE`
            // expands to `FILE_APPEND_DATA`, which means
            // `FILE_CREATE_PIPE_INSTANCE` for a named pipe and is deliberately
            // denied. Requesting it here made the service deny its own stop
            // wake-up and left MSI uninstall waiting on `ConnectNamedPipe`.
            CLIENT_ACCESS,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle != INVALID_HANDLE_VALUE && !handle.is_null() {
        unsafe { CloseHandle(handle) };
    }
}

/// Accepts control connections until `shutdown` is set. Returns only when it is:
/// the caller pokes the pipe to wake this loop.
pub fn serve(root: PathBuf, control: Arc<Control>, shutdown: Arc<AtomicBool>) {
    let (custody_root, custody_control, custody_shutdown) =
        (root.clone(), Arc::clone(&control), Arc::clone(&shutdown));
    let custody = std::thread::spawn(move || {
        serve_channel(
            custody_root,
            custody_control,
            custody_shutdown,
            Scope::Custody,
        )
    });
    serve_channel(root, control, Arc::clone(&shutdown), Scope::Control);
    shutdown.store(true, Ordering::SeqCst);
    poke();
    let _ = custody.join();
}

fn serve_channel(root: PathBuf, control: Arc<Control>, shutdown: Arc<AtomicBool>, scope: Scope) {
    while !shutdown.load(Ordering::SeqCst) {
        let handle = match create_instance(&root, scope) {
            Ok(handle) => handle,
            Err(reason) => {
                log_line(&root, &reason);
                shutdown.store(true, Ordering::SeqCst);
                poke();
                return;
            }
        };
        let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) } != 0
            || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
        if shutdown.load(Ordering::SeqCst) || !connected {
            unsafe {
                DisconnectNamedPipe(handle);
                CloseHandle(handle);
            }
            continue;
        }
        let served = Arc::clone(&control);
        // `HANDLE` is a raw pointer and therefore not `Send`; it is a kernel
        // handle valid in every thread of this process, and exactly one thread
        // owns it from here to its `CloseHandle`.
        let owned = handle as usize;
        let state_root = root.clone();
        std::thread::spawn(move || serve_connection(owned as HANDLE, &state_root, &served, scope));
    }
}

#[cfg(test)]
#[path = "pipe_tests.rs"]
mod tests;
