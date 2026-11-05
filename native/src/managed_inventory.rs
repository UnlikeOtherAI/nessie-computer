//! Independent live /proc reads plus authenticated native creation probes.
//! Socket/journal enumeration alone is deliberately never completeness proof.
use crate::{
    managed_release, managed_runtime::Record, managed_runtime_context, protocol::NativeError,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::time::Duration;

fn refused() -> NativeError {
    NativeError::new("EXECUTOR_MANAGED_INVENTORY_UNVERIFIED")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Process {
    pid: i32,
    parent_pid: i32,
    started_at: String,
    product: bool,
}

fn processes() -> Result<Vec<Process>, NativeError> {
    let mut found = Vec::new();
    for entry in fs::read_dir("/proc").map_err(|_| refused())? {
        let entry = entry.map_err(|_| refused())?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
        else {
            continue;
        };
        let stat = match fs::read_to_string(entry.path().join("stat")) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(refused()),
        };
        let metadata = fs::metadata(entry.path()).map_err(|_| refused())?;
        if metadata.uid() != unsafe { libc::getuid() } && metadata.uid() != 0 {
            continue;
        }
        let command = stat
            .split_once('(')
            .and_then(|(_, rest)| rest.rsplit_once(')').map(|(name, _)| name))
            .ok_or_else(refused)?;
        if metadata.uid() == 0
            && command != "node"
            && command != "nodejs"
            && !["nessie", "Nessie", "nessie-desktop"].contains(&command)
            && !command.starts_with("nessie-executor")
        {
            continue;
        }
        let end = stat.rfind(')').ok_or_else(refused)?;
        let fields: Vec<&str> = stat[end + 1..].split_whitespace().collect();
        let parent = fields
            .get(1)
            .and_then(|field| field.parse::<i32>().ok())
            .ok_or_else(refused)?;
        let started = fields.get(19).ok_or_else(refused)?.to_string();
        if !started.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(refused());
        }
        let executable = match fs::read_link(entry.path().join("exe")) {
            Ok(executable) => executable,
            // A positively observed zombie/kernel thread has no executable.
            Err(_) if fields[0] == "Z" => continue,
            Err(_) => return Err(refused()),
        };
        let name = executable
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(refused)?;
        if [
            "node",
            "nodejs",
            "nessie-executor-runtime",
            "nessie-executor-native",
            "nessie",
            "Nessie",
            "nessie-desktop",
        ]
        .contains(&name)
            || name.starts_with("nessie-executor")
        {
            // Elevated product/Node runtime may read the owner's credentials;
            // this per-user supervisor cannot grant it personal authority.
            if metadata.uid() == 0 {
                return Err(refused());
            }
            found.push(Process {
                pid,
                parent_pid: parent,
                started_at: started,
                product: true,
            });
        } else {
            found.push(Process {
                pid,
                parent_pid: parent,
                started_at: started,
                product: false,
            });
        }
    }
    Ok(found)
}

fn probe(root: &Path, native_pid: i32, birth: &str, nonce: &str) -> Result<Record, NativeError> {
    let socket_name = format!(
        "{}_{native_pid}-{birth}.sock",
        &managed_runtime_context::boot_id()?[..8]
    );
    let mut stream = crate::managed_socket::connect(&root.join("managed-runtimes"), &socket_name)?;
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|_| refused())?;
    stream
        .set_write_timeout(Some(Duration::from_millis(500)))
        .map_err(|_| refused())?;
    let mut peer = std::mem::MaybeUninit::<libc::ucred>::uninit();
    let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            peer.as_mut_ptr().cast(),
            &mut size,
        )
    } != 0
        || size as usize != std::mem::size_of::<libc::ucred>()
    {
        return Err(refused());
    }
    let peer = unsafe { peer.assume_init() };
    if peer.pid != native_pid
        || peer.uid != unsafe { libc::getuid() }
        || managed_runtime_context::birth(native_pid)? != birth
    {
        return Err(refused());
    }
    stream
        .write_all(format!("{nonce}\n").as_bytes())
        .map_err(|_| refused())?;
    let mut bytes = Vec::new();
    stream
        .take(8193)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    if bytes.len() > 8192 {
        return Err(refused());
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if value["nonce"] != nonce {
        return Err(refused());
    }
    let record: Record = serde_json::from_value(value["record"].clone()).map_err(|_| refused())?;
    if record.boot_id != managed_runtime_context::boot_id()?
        || record.protocol_version != 1
        || record.guard_version != managed_release::GUARD_VERSION
        || record.supervisor_pid != native_pid
        || record.supervisor_started_at != birth
        || managed_runtime_context::birth(record.child_pid)? != record.child_started_at
    {
        return Err(refused());
    }
    Ok(record)
}

fn loaded_digest(pid: i32) -> Result<String, NativeError> {
    let mut executable = File::open(format!("/proc/{pid}/exe")).map_err(|_| refused())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = executable.read(&mut buffer).map_err(|_| refused())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn barrier(nonce: &str) -> Result<(), NativeError> {
    if nonce.len() != 64 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(refused());
    }
    let release = managed_release::load()?;
    managed_runtime_context::require_custody_context()?;
    let barrier = managed_runtime_context::Barrier::acquire()?;
    barrier.check_protection()?;
    crate::managed_installed::verify(&release)?;
    let own = unsafe { libc::getpid() };
    let native_digest = loaded_digest(own)?;
    // Root launch journals contain public process-generation metadata only.
    // A dead elevated parent is not absence of its escaped descendants. Users
    // cannot edit these records, and this reader never infers a current-boot
    // orphan stopped from its root PID alone.
    let root_journal =
        Path::new(crate::managed_machine_barrier::ROOT_RUNTIME).join("managed-runtimes");
    for entry in fs::read_dir(root_journal).map_err(|_| refused())? {
        let path = entry.map_err(|_| refused())?.path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(refused)?;
        if name.ends_with(".sock") {
            continue;
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .map_err(|_| refused())?;
        let metadata = file.metadata().map_err(|_| refused())?;
        if !metadata.is_file()
            || metadata.uid() != 0
            || metadata.nlink() != 1
            || metadata.mode() & 0o022 != 0
            || metadata.len() > 8192
        {
            return Err(refused());
        }
        if name.ends_with(".draft") {
            let prefix = name
                .split_once('_')
                .map(|(prefix, _)| prefix)
                .ok_or_else(refused)?;
            if prefix.len() != 8
                || !prefix.bytes().all(|byte| byte.is_ascii_hexdigit())
                || prefix == &managed_runtime_context::boot_id()?[..8]
            {
                return Err(refused());
            }
            continue; // Different boot: unpublished old child never crossed its gate.
        }
        if !name.ends_with(".json") {
            return Err(refused());
        }
        let record: Record = serde_json::from_reader(file).map_err(|_| refused())?;
        if !managed_runtime_context::valid_boot_id(&record.boot_id)
            || record.supervisor_pid <= 0
            || record.child_pid <= 0
            || record.protocol_version != 1
            || name
                != format!(
                    "{}_{}-{}.json",
                    &record.boot_id[..8],
                    record.supervisor_pid,
                    record.supervisor_started_at
                )
        {
            return Err(refused());
        }
        if record.boot_id == managed_runtime_context::boot_id()? {
            return Err(refused());
        }
        // A different kernel boot proves all old elevated descendants gone.
        // Only the root controller may later reclaim this root-owned metadata.
    }
    let initial = processes()?;
    let mut records = Vec::new();
    let mut retained_processes = Vec::new();
    for process in &initial {
        if process.pid == own || !process.product {
            continue;
        }
        let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, process.pid, 0) };
        if descriptor < 0 {
            return Err(refused());
        }
        retained_processes.push(unsafe { File::from_raw_fd(descriptor as i32) });
        if loaded_digest(process.pid)? == native_digest {
            let record = probe(&barrier.root, process.pid, &process.started_at, nonce)?;
            if record.release_digest != release.digest
                || loaded_digest(record.child_pid)? != release.node_digest
            {
                return Err(refused());
            }
            records.push(record);
        }
    }
    // Persistent claims survive parent death. An unpublished draft cannot
    // have opened the child gate; a published same-boot orphan cannot be
    // dismissed from the root PID alone because it may have descendants.
    let journal_directory = barrier.root.join("managed-runtimes");
    for entry in fs::read_dir(&journal_directory).map_err(|_| refused())? {
        let path = entry.map_err(|_| refused())?.path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(refused)?;
        let Some((generation, extension)) = name.rsplit_once('.') else {
            return Err(refused());
        };
        let Some((boot_prefix, generation)) = generation.split_once('_') else {
            return Err(refused());
        };
        if boot_prefix.len() != 8 || !boot_prefix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(refused());
        }
        let Some((pid, start)) = generation.split_once('-') else {
            return Err(refused());
        };
        let pid = pid.parse::<i32>().map_err(|_| refused())?;
        if pid <= 0 || start.is_empty() || !start.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(refused());
        }
        if extension == "sock" {
            continue;
        }
        if extension != "json" && extension != "draft" {
            return Err(refused());
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .map_err(|_| refused())?;
        let entry = file.metadata().map_err(|_| refused())?;
        if !entry.is_file()
            || entry.uid() != unsafe { libc::getuid() }
            || entry.mode() & 0o077 != 0
            || entry.nlink() != 1
            || entry.len() > 8192
        {
            return Err(refused());
        }
        let live = initial
            .iter()
            .any(|process| process.pid == pid && process.started_at == start);
        if extension == "draft" {
            if boot_prefix == &managed_runtime_context::boot_id()?[..8] && live {
                return Err(refused());
            }
            fs::remove_file(&path).map_err(|_| refused())?;
        } else {
            let retained: Record = serde_json::from_reader(file).map_err(|_| refused())?;
            if retained.supervisor_pid != pid
                || retained.supervisor_started_at != start
                || !managed_runtime_context::valid_boot_id(&retained.boot_id)
                || &retained.boot_id[..8] != boot_prefix
            {
                return Err(refused());
            }
            if retained.boot_id != managed_runtime_context::boot_id()? {
                // A different boot positively stopped the entire old OS tree.
                fs::remove_file(&path).map_err(|_| refused())?;
                let socket = path.with_extension("sock");
                if socket.exists() {
                    fs::remove_file(socket).map_err(|_| refused())?;
                }
            } else if !records
                .iter()
                .any(|record| record.supervisor_pid == pid && record.supervisor_started_at == start)
            {
                return Err(refused());
            }
        }
    }
    File::open(&journal_directory)
        .map_err(|_| refused())?
        .sync_all()
        .map_err(|_| refused())?;
    // Every independently discovered Node/product runtime must have creation
    // proof from a retained supervisor; unrelated/unmanaged Node is refused.
    for process in &initial {
        if process.pid != own
            && process.product
            && !records.iter().any(|record| {
                record.supervisor_pid == process.pid
                    && record.supervisor_started_at == process.started_at
                    || record.child_pid == process.pid
                        && record.child_started_at == process.started_at
                        && record.supervisor_pid == process.parent_pid
            })
        {
            return Err(refused());
        }
    }
    // Descendants are discovered through the complete same-UID process table,
    // not the cooperative journal. Arbitrary/unproven surviving host children
    // prevent activation even when the supervisor itself has valid provenance.
    for process in &initial {
        if process.pid == own || process.product {
            continue;
        }
        let mut parent = process.parent_pid;
        let mut depth = 0;
        while parent > 1 && depth < initial.len() {
            let Some(ancestor) = initial.iter().find(|candidate| candidate.pid == parent) else {
                break;
            };
            if ancestor.product {
                return Err(refused());
            }
            parent = ancestor.parent_pid;
            depth += 1;
        }
        if depth == initial.len() {
            return Err(refused());
        }
    }
    // A second independent scan catches changed generations during the probe.
    let after = processes()?;
    if initial.iter().filter(|process| process.product).count()
        != after.iter().filter(|process| process.product).count()
        || initial
            .iter()
            .filter(|process| process.product)
            .any(|process| {
                !after.iter().any(|current| {
                    current.pid == process.pid
                        && current.started_at == process.started_at
                        && current.parent_pid == process.parent_pid
                })
            })
    {
        return Err(refused());
    }
    let controller = records
        .iter()
        .find(|record| record.child_pid == unsafe { libc::getppid() })
        .ok_or_else(refused)?;
    let transition = crate::managed_transition::Transition::publish(&barrier.root, controller)?;
    println!(
        "{}",
        serde_json::json!({ "status":"verified", "protocolVersion":1,
        "nonce":nonce, "root":barrier.root, "guardVersion":managed_release::GUARD_VERSION,
        "releaseDigest":release.digest, "records":records })
    );
    std::io::stdout().flush().map_err(|_| refused())?;
    // The controller publishes its durable guard fence while this exact native
    // process keeps the launch lock. EOF/crash releases only the lock, never the
    // persistent protection. No profile/token bytes pass through this protocol.
    let mut end = [0_u8; 8];
    let count = std::io::stdin().read(&mut end).map_err(|_| refused())?;
    if &end[..count] != b"release\n" {
        return Err(refused());
    }
    transition.release()?;
    drop(retained_processes);
    Ok(())
}
