//! Actual live kernel processes plus fresh signed native creation probes.
use crate::{managed_release, managed_runtime::Record, managed_runtime_context, macos_processes,
    protocol::NativeError};
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path, time::Duration};

fn refused() -> NativeError { NativeError::new("EXECUTOR_MANAGED_INVENTORY_UNVERIFIED") }
fn product(process: &macos_processes::Process) -> bool {
    let name = process.executable.file_name().and_then(|name| name.to_str()).unwrap_or("");
    // Personal-agent custody owns Nessie Computer's runtimes. An unrelated
    // Node program or another app's UI is not one of its credential actors.
    name.starts_with("nessie-executor")
}
fn probe(root: &Path, process: &macos_processes::Process, nonce: &str) -> Result<Record, NativeError> {
    let socket = format!("{}_{}-{}.sock", &managed_runtime_context::boot_id()?[..8], process.pid, process.started_at);
    let mut stream = crate::managed_socket::connect(&root.join("managed-runtimes"), &socket)?;
    if crate::managed_runtime::peer(&stream)? != process.pid { return Err(refused()); }
    stream.set_read_timeout(Some(Duration::from_millis(500))).map_err(|_| refused())?;
    stream.set_write_timeout(Some(Duration::from_millis(500))).map_err(|_| refused())?;
    crate::macos_provenance::require_process(process.pid)?;
    stream.write_all(format!("{nonce}\n").as_bytes()).map_err(|_| refused())?;
    let mut bytes = Vec::new(); stream.take(8193).read_to_end(&mut bytes).map_err(|_| refused())?;
    if bytes.len() > 8192 { return Err(refused()); }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if value["nonce"] != nonce { return Err(refused()); }
    let record: Record = serde_json::from_value(value["record"].clone()).map_err(|_| refused())?;
    if record.protocol_version != 1 || record.guard_version != managed_release::GUARD_VERSION
        || record.boot_id != managed_runtime_context::boot_id()? || record.supervisor_pid != process.pid
        || record.supervisor_started_at != process.started_at
        || managed_runtime_context::birth(record.child_pid)? != record.child_started_at { return Err(refused()); }
    Ok(record)
}

fn journal_records(root: &Path, records: &[Record]) -> Result<(), NativeError> {
    let directory = root.join("managed-runtimes");
    let boot = managed_runtime_context::boot_id()?;
    for entry in fs::read_dir(&directory).map_err(|_| refused())? {
        let path = entry.map_err(|_| refused())?.path();
        let name = path.file_name().and_then(|name| name.to_str()).ok_or_else(refused)?;
        if name.ends_with(".sock") { continue; }
        let (stem, extension) = name.rsplit_once('.').ok_or_else(refused)?;
        let (prefix, generation) = stem.split_once('_').ok_or_else(refused)?;
        let (pid, start) = generation.split_once('-').ok_or_else(refused)?;
        let pid = pid.parse::<i32>().map_err(|_| refused())?;
        if prefix.len() != 8 || !prefix.bytes().all(|byte| byte.is_ascii_hexdigit()) || pid <= 0
            || start.is_empty() || !start.bytes().all(|byte| byte.is_ascii_digit())
            || !["json", "draft"].contains(&extension) { return Err(refused()); }
        let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(&path).map_err(|_| refused())?;
        let entry = file.metadata().map_err(|_| refused())?;
        if !entry.is_file() || entry.uid() != unsafe { libc::getuid() } || entry.mode() & 0o077 != 0
            || entry.nlink() != 1 || entry.len() > 8192 { return Err(refused()); }
        if extension == "draft" {
            if prefix == &boot[..8] && macos_processes::information(pid)?.is_some_and(|live| live.started_at == start) {
                return Err(refused());
            }
            fs::remove_file(&path).map_err(|_| refused())?; continue;
        }
        let record: Record = serde_json::from_reader(file).map_err(|_| refused())?;
        if !managed_runtime_context::valid_boot_id(&record.boot_id) || record.supervisor_pid != pid
            || record.supervisor_started_at != start || &record.boot_id[..8] != prefix { return Err(refused()); }
        if record.boot_id != boot {
            fs::remove_file(&path).map_err(|_| refused())?;
            let socket = path.with_extension("sock");
            if socket.try_exists().map_err(|_| refused())? { fs::remove_file(socket).map_err(|_| refused())?; }
        } else if !records.contains(&record) {
            return Err(refused()); // Root absence never erases possible escaped descendants.
        }
    }
    File::open(directory).map_err(|_| refused())?.sync_all().map_err(|_| refused())
}

fn validate_table(table: &[macos_processes::Process], records: &[Record], own: i32) -> Result<(), NativeError> {
    for process in table.iter().filter(|process| !process.zombie && process.pid != own) {
        if product(process) {
            if process.uid == 0 || !records.iter().any(|record|
                record.supervisor_pid == process.pid && record.supervisor_started_at == process.started_at
                || record.child_pid == process.pid && record.child_started_at == process.started_at
                    && record.supervisor_pid == process.parent_pid) { return Err(refused()); }
            continue;
        }
        let mut parent = process.parent_pid; let mut depth = 0;
        while parent > 1 && depth < table.len() {
            let Some(ancestor) = table.iter().find(|item| item.pid == parent) else { break; };
            if product(ancestor) { return Err(refused()); }
            parent = ancestor.parent_pid; depth += 1;
        }
        if depth == table.len() { return Err(refused()); }
    }
    Ok(())
}

pub fn barrier(nonce: &str) -> Result<(), NativeError> {
    if nonce.len() != 64 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err(refused()); }
    let release = managed_release::load()?;
    managed_runtime_context::require_custody_context()?;
    let barrier = managed_runtime_context::Barrier::acquire()?; barrier.check_protection()?;
    crate::managed_macos_installed::verify(&release)?;
    // Every elevated launch journal is public, but a same-boot orphan may
    // retain a privileged reader. Only a different boot proves it gone.
    for entry in fs::read_dir(Path::new(crate::managed_machine_barrier::ROOT_RUNTIME).join("managed-runtimes"))
        .map_err(|_| refused())? {
        let path = entry.map_err(|_| refused())?.path();
        if path.extension().is_some_and(|value| value == "sock") { continue; }
        let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(&path).map_err(|_| refused())?;
        let record: Record = serde_json::from_reader(file).map_err(|_| refused())?;
        if record.boot_id == managed_runtime_context::boot_id()? { return Err(refused()); }
    }
    let own = unsafe { libc::getpid() };
    let initial = macos_processes::all()?;
    let observations = macos_processes::Observations::new()?;
    let mut records = Vec::new();
    for process in initial.iter().filter(|process| process.pid != own && product(process) && !process.zombie) {
        if process.uid == 0 { return Err(refused()); }
        observations.retain(process)?;
        if process.executable == release.directory.join("nessie-executor-native") {
            let record = probe(&barrier.root, process, nonce)?;
            let child = initial.iter().find(|child| child.pid == record.child_pid).ok_or_else(refused)?;
            if record.release_digest != release.digest
                || child.executable != release.directory.join("nessie-executor-runtime") { return Err(refused()); }
            crate::macos_provenance::require_process(child.pid)?;
            records.push(record);
        }
    }
    journal_records(&barrier.root, &records)?;
    validate_table(&initial, &records, own)?;
    let after = macos_processes::all()?; validate_table(&after, &records, own)?;
    let product_generations = |table: &[macos_processes::Process]| {
        let mut generations = table.iter().filter(|item| product(item))
            .map(|item| (item.pid, item.parent_pid, item.started_at.clone(), item.executable.clone())).collect::<Vec<_>>();
        generations.sort_unstable(); generations
    };
    if product_generations(&initial) != product_generations(&after) { return Err(refused()); }
    observations.unchanged()?;
    let controller = records.iter().find(|record| record.child_pid == unsafe { libc::getppid() }).ok_or_else(refused)?;
    let transition = crate::managed_transition::Transition::publish(&barrier.root, controller)?;
    println!("{}", serde_json::json!({"status":"verified","protocolVersion":1,"nonce":nonce,
        "root":barrier.root,"guardVersion":managed_release::GUARD_VERSION,"releaseDigest":release.digest,"records":records}));
    std::io::stdout().flush().map_err(|_| refused())?;
    let mut line = [0_u8; 8]; let count = std::io::stdin().read(&mut line).map_err(|_| refused())?;
    if &line[..count] != b"release\n" { return Err(refused()); }
    transition.release()?; Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsigned_inventory_never_reports_compatibility() { assert!(barrier(&"a".repeat(64)).is_err()); }
    #[test]
    fn unrelated_node_does_not_require_nessie_custody() {
        let process = macos_processes::Process { pid: 7, parent_pid: 1, group: 7, uid: 501,
            started_at: "10".into(), executable: "/tmp/node".into(), zombie: false };
        assert!(!product(&process), "a person's other Node programs do not own Nessie Computer's grant");
        assert!(validate_table(&[process], &[], 8).is_ok());
    }
    #[test]
    fn an_unregistered_nessie_runtime_still_refuses_credential_activation() {
        let process = macos_processes::Process { pid: 7, parent_pid: 1, group: 7, uid: 501,
            started_at: "10".into(), executable: "/tmp/nessie-executor-runtime".into(), zombie: false };
        assert!(validate_table(&[process], &[], 8).is_err());
    }
}
