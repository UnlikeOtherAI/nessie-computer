//! Retire pre-updater creators only after independent machine-wide clearance.
use super::{admission_unix, unix_runtime};
use nessie_executor_updater::catalog::UpdateResult;
use std::{fs::{self, File, OpenOptions}, io::Read, os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf}};

const ERROR: &str = "update.bootstrap_required";
#[cfg(target_os = "linux")]
const RELEASES: &str = "/usr/lib/nessie-executor/releases";
#[cfg(target_os = "macos")]
const RELEASES: &str = "/Library/Application Support/Nessie Executor/releases";
const CREATORS: [&str; 3] = ["nessie-executor-native", "nessie-executor-runtime", "nessie-executor.cjs"];

fn protected(path: &Path) -> UpdateResult<File> {
    let entry = fs::symlink_metadata(path).map_err(|_| ERROR)?;
    if !entry.is_file() || entry.file_type().is_symlink() || entry.uid() != 0
        || entry.nlink() != 1 || entry.mode() & 0o222 != 0 { return Err(ERROR); }
    let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path).map_err(|_| ERROR)?;
    let opened = file.metadata().map_err(|_| ERROR)?;
    if opened.dev() != entry.dev() || opened.ino() != entry.ino() { return Err(ERROR); }
    Ok(file)
}

fn candidates(current: &str) -> UpdateResult<Vec<PathBuf>> {
    let root = Path::new(RELEASES);
    admission_unix::directory(root)?;
    let mut candidates = Vec::new();
    for entry in fs::read_dir(root).map_err(|_| ERROR)? {
        let path = entry.map_err(|_| ERROR)?.path();
        let name = path.file_name().and_then(|name| name.to_str()).ok_or(ERROR)?;
        if name == current || name.len() != 64 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) { continue; }
        admission_unix::directory(&path)?;
        let file = protected(&path.join("manifest.json"))?;
        if file.metadata().map_err(|_| ERROR)?.len() > 65_536 { return Err(ERROR); }
        let mut bytes = Vec::new(); file.take(65_537).read_to_end(&mut bytes).map_err(|_| ERROR)?;
        let manifest: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
        if manifest["updateAdmissionProtocol"] == 1 { continue; }
        let retired = CREATORS.iter().try_fold(true, |retired, name| {
            let entry = fs::symlink_metadata(path.join(name)).map_err(|_| ERROR)?;
            if !entry.is_file() || entry.file_type().is_symlink() || entry.uid() != 0 || entry.nlink() != 1
                || entry.mode() & 0o222 != 0 { return Err(ERROR); }
            Ok(retired && entry.mode() & 0o777 == 0o400)
        })?;
        if !retired { candidates.push(path); }
        if candidates.len() > 4096 { return Err(ERROR); }
    }
    Ok(candidates)
}

/// New factories refuse activity until every legacy creator is retired. This
/// check runs under the same existing machine inode as native child creation.
pub(super) fn remaining(current: &str) -> UpdateResult<bool> { Ok(!candidates(current)?.is_empty()) }

/// The protected worker retries this step while old work completes naturally.
/// It never signals a process, deletes a journal or replaces a custody inode.
pub(super) fn bootstrap() -> UpdateResult<bool> {
    unix_runtime::privileged()?;
    let release = crate::managed_release::installed().map_err(|_| ERROR)?;
    if !remaining(&release.digest)? { return Ok(true); }
    let _barrier = crate::managed_machine_barrier::MachineBarrier::acquire().map_err(|_| "update.admission_busy")?;
    let mut maintenance = admission_unix::read()?;
    maintenance.draining = true;
    maintenance.restart_ready = false;
    admission_unix::write(&maintenance)?;
    if !super::unix_clearance::ready_with(true, None)? { return Ok(false); }
    retire_cleared(&release.digest)?;
    Ok(true)
}

/// Caller retains MachineBarrier after independent whole-machine clearance.
pub(super) fn retire_cleared(digest: &str) -> UpdateResult<()> {
    unix_runtime::privileged()?;
    for directory in candidates(digest)? {
        for name in CREATORS {
            let file = protected(&directory.join(name))?;
            // Keep the exact bytes for audit/repair while removing every old
            // user execution/read route. Updater-aware releases select current
            // and enforce maintenance themselves, so their permissions stay intact.
            file.set_permissions(fs::Permissions::from_mode(0o400)).map_err(|_| ERROR)?;
            file.sync_all().map_err(|_| ERROR)?;
        }
        File::open(directory).and_then(|file| file.sync_all()).map_err(|_| ERROR)?;
    }
    Ok(())
}
