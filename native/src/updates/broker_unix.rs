//! Root-only socket broker and a detached native installation worker.
use super::{channel::SOCKET, host::{self, Host}, unix_runtime};
use nessie_executor_updater::{coordinator::{Coordinator, Installer}, network::Network, protocol::Request, storage::Store};
use std::{fs, io::{BufRead, BufReader, Read, Write}, os::unix::{fs::{FileTypeExt, MetadataExt, PermissionsExt},
    net::{UnixListener, UnixStream}, process::CommandExt}, process::{Child, Command, Stdio},
    sync::{atomic::{AtomicUsize, Ordering}, Arc}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

const ERROR: &str = "update.coordinator_unavailable";
fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}
fn spawn_worker() -> Result<Child, String> {
    let store = Store::new(host::root().map_err(str::to_owned)?);
    let lease = store.runner().map_err(str::to_owned)?;
    drop(lease);
    let image = unix_runtime::worker_image().map_err(str::to_owned)?;
    let mut command = Command::new(image);
    command.arg("update-worker").env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .current_dir(host::root().map_err(str::to_owned)?)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    unsafe { command.pre_exec(|| if libc::setsid() < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }); }
    command.spawn().map_err(|_| ERROR.into())
}
fn connection(stream: UnixStream) -> Result<(), String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).map_err(|_| ERROR)?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).map_err(|_| ERROR)?;
    let mut bytes = Vec::new();
    let mut reader = BufReader::new(stream.take(16_385));
    reader.read_until(b'\n', &mut bytes).map_err(|_| ERROR)?;
    if bytes.len() > 16_384 || !bytes.ends_with(b"\n") { return Err(ERROR.into()); }
    let response = serde_json::from_slice::<Request>(&bytes).map_err(|_| ERROR.to_owned()).and_then(|request| {
        let store = Store::new(host::root().map_err(str::to_owned)?);
        let network = Network::default();
        let installer = Host;
        Coordinator { store: &store, network: &network, installer: &installer }.control(request, now())
            .map(|value| serde_json::to_value(value).unwrap()).map_err(str::to_owned)
    });
    let response = response.unwrap_or_else(|code| serde_json::json!({"error":code}));
    let mut bytes = serde_json::to_vec(&response).map_err(|_| ERROR)?;
    bytes.push(b'\n');
    let mut stream = reader.into_inner().into_inner();
    stream.write_all(&bytes).map_err(|_| ERROR.into())
}

pub(super) fn run() -> Result<(), String> {
    unix_runtime::verify_worker().map_err(str::to_owned)?;
    let store = Store::new(host::root().map_err(str::to_owned)?);
    let _broker = store.broker().map_err(str::to_owned)?;
    // The recovered exclusive broker lease proves a prior endpoint is stale.
    // Keep every accepted transaction; replace only the dead process's socket.
    match fs::symlink_metadata(SOCKET) {
        Ok(entry) => {
            if !entry.file_type().is_socket() || entry.uid() != 0 { return Err(ERROR.into()); }
            fs::remove_file(SOCKET).map_err(|_| ERROR)?;
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(_) => return Err(ERROR.into()),
    }
    let listener = UnixListener::bind(SOCKET).map_err(|_| ERROR)?;
    fs::set_permissions(SOCKET, fs::Permissions::from_mode(0o666)).map_err(|_| ERROR)?;
    listener.set_nonblocking(true).map_err(|_| ERROR)?;
    let active = Arc::new(AtomicUsize::new(0));
    let mut worker: Option<Child> = None;
    let mut checked = Instant::now() - Duration::from_secs(3);
    loop {
        if checked.elapsed() >= Duration::from_secs(3) {
            if worker.as_mut().is_none_or(|child| child.try_wait().ok().flatten().is_some()) {
                worker = spawn_worker().ok();
            }
            checked = Instant::now();
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if active.load(Ordering::Acquire) >= 16 { continue; }
                active.fetch_add(1, Ordering::AcqRel);
                let count = Arc::clone(&active);
                std::thread::spawn(move || { let _ = connection(stream); count.fetch_sub(1, Ordering::AcqRel); });
            },
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return Err(ERROR.into()),
        }
    }
}

pub(super) fn worker() -> Result<(), String> {
    unix_runtime::verify_worker().map_err(str::to_owned)?;
    let store = Store::new(host::root().map_err(str::to_owned)?);
    let _runner = store.runner().map_err(str::to_owned)?;
    store.mutate_journal(|journal| { journal.check_requested_at = Some(now()); Ok(()) }).map_err(str::to_owned)?;
    let network = Network::default();
    let installer = Host;
    let coordinator = Coordinator { store: &store, network: &network, installer: &installer };
    loop {
        coordinator.tick(now()).map_err(str::to_owned)?;
        if store.journal().map_err(str::to_owned)?.pending.is_none()
            && installer.installed().map_err(str::to_owned)?.source_commit != env!("NESSIE_EXECUTOR_SOURCE_COMMIT") {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}
