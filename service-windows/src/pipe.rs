//! Separate pairing-control and runtime-admission channels, one JSON object per line.
//!
//! Each channel has its own bounded worker budget and transport deadlines.
//! An idle custody client cannot consume pairing-control workers. Every instance is
//! created with a descriptor built from the accounts recorded *at that moment*,
//! which is how an elevated grant takes effect without restarting the service.

use std::{
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING, HANDLE,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_NOWAIT, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
};

use crate::{
    control::Control,
    log::log_line,
    paths::{control_client_sids, control_clients_root},
    pipe_transport::{Connection, Slots},
    protocol::{parse_request, Command, Response, MAX_REQUEST_BYTES},
    security::{connected_client_identity, current_user_sid_string, PipeSecurity, CLIENT_ACCESS},
};

pub const PIPE_NAME: &str = nessie_windows_common::CONTROL_PIPE_NAME;

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

/// Fixed per-instance buffers, independent of a client's declared input size.
const PIPE_BUFFER_BYTES: u32 = 128 * 1024;
const MAX_CONNECTIONS: usize = 16;
const IO_TIMEOUT: Duration = Duration::from_secs(5);

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

fn create_instance(root: &Path, scope: Scope, name: &str) -> Result<Connection, String> {
    let own = current_user_sid_string()
        .map_err(|_| "Windows would not report the Nessie Computer account.".to_owned())?;
    let mut security = match scope {
        Scope::Control => PipeSecurity::new(&admitted_sids(root), &own)?,
        Scope::Custody => PipeSecurity::custody(&own)?,
    };
    let attributes = security.attributes();
    let handle = unsafe {
        CreateNamedPipeW(
            wide(name).as_ptr(),
            PIPE_ACCESS_DUPLEX,
            // Byte mode with nonblocking I/O, and never over the network: a DACL
            // alone would still admit a domain account remotely.
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            (MAX_CONNECTIONS + 1) as u32,
            PIPE_BUFFER_BYTES,
            PIPE_BUFFER_BYTES,
            PIPE_DEFAULT_TIMEOUT_MS,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return Err("Nessie Computer could not open its control channel.".to_owned());
    }
    unsafe { Connection::from_handle(handle) }
        .map_err(|_| "Nessie Computer could not open its control channel.".to_owned())
}

/// Command execution keeps its existing bounds. Transport gets separate read
/// and reply deadlines so a legitimate long-running command can still reply.
fn serve_connection(
    mut connection: Connection,
    root: &Path,
    control: &Control,
    scope: Scope,
    shutdown: &AtomicBool,
    timeout: Duration,
) {
    let handle = connection.handle();
    let response =
        match connection.request(MAX_REQUEST_BYTES + 1, Instant::now() + timeout, shutdown) {
            None => None,
            Some(line) => {
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
        };
    if let Some(response) = response {
        connection.reply(
            response.encode().as_bytes(),
            Instant::now() + timeout,
            shutdown,
        );
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

/// Wake-up retained for service callers; accept and transport also observe shutdown.
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
            Scope::Custody.name(),
            IO_TIMEOUT,
        )
    });
    serve_channel(
        root,
        control,
        Arc::clone(&shutdown),
        Scope::Control,
        Scope::Control.name(),
        IO_TIMEOUT,
    );
    shutdown.store(true, Ordering::SeqCst);
    poke();
    let _ = custody.join();
}

fn serve_channel(
    root: PathBuf,
    control: Arc<Control>,
    shutdown: Arc<AtomicBool>,
    scope: Scope,
    name: &str,
    timeout: Duration,
) {
    let slots = Slots::new(MAX_CONNECTIONS);
    let mut failed = false;
    while !shutdown.load(Ordering::SeqCst) {
        let Some(permit) = slots.acquire() else {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        };
        let connection = match create_instance(&root, scope, name) {
            Ok(connection) => {
                failed = false;
                connection
            }
            Err(reason) => {
                if !failed {
                    log_line(&root, &reason);
                }
                failed = true;
                std::thread::sleep(Duration::from_millis(250));
                continue;
            }
        };
        let connected = loop {
            if shutdown.load(Ordering::Acquire) {
                break false;
            }
            // In NOWAIT mode a successful call merely starts listening.
            let listening =
                unsafe { ConnectNamedPipe(connection.handle(), std::ptr::null_mut()) } != 0;
            let error = if listening {
                ERROR_PIPE_LISTENING
            } else {
                unsafe { GetLastError() }
            };
            match error {
                ERROR_PIPE_CONNECTED => break true,
                ERROR_PIPE_LISTENING => std::thread::sleep(Duration::from_millis(10)),
                _ => break false,
            }
        };
        if !connected {
            continue;
        }
        let served = Arc::clone(&control);
        let state_root = root.clone();
        let stopped = Arc::clone(&shutdown);
        // Dropping a failed spawn's closure releases both the handle and permit.
        if std::thread::Builder::new()
            .name("nessie-control".into())
            .spawn(move || {
                let _permit = permit;
                serve_connection(connection, &state_root, &served, scope, &stopped, timeout);
            })
            .is_err()
        {
            log_line(
                &root,
                "Nessie Computer could not start a control worker; it will retry.",
            );
            std::thread::sleep(Duration::from_millis(250));
        }
    }
}

#[cfg(test)]
#[path = "pipe_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "pipe_lifecycle_tests.rs"]
mod lifecycle_tests;
