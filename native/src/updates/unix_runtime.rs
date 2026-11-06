//! Root-owned updater images survive replacement of the installed Node/runtime.
use super::{admission_unix, host::root};
use nessie_executor_updater::{catalog::UpdateResult, coordinator::Installed, storage::Store};
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, os::unix::fs::{DirBuilderExt, MetadataExt,
    OpenOptionsExt, PermissionsExt}, path::{Path, PathBuf}};

pub(super) const ERROR: &str = "update.installed_release_unverified";
pub(super) fn privileged() -> UpdateResult<()> {
    if unsafe { libc::getuid() } != 0 || unsafe { libc::geteuid() } != 0 {
        return Err("update.installation_authorization_required");
    }
    Ok(())
}
pub(super) fn directory(path: &Path) -> UpdateResult<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => {},
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            admission_unix::directory(path.parent().ok_or(ERROR)?)?;
            fs::DirBuilder::new().mode(0o755).create(path).map_err(|_| ERROR)?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).map_err(|_| ERROR)?;
            File::open(path.parent().ok_or(ERROR)?).and_then(|file| file.sync_all()).map_err(|_| ERROR)?;
        },
        Err(_) => return Err(ERROR),
    }
    admission_unix::directory(path)
}
pub(super) fn installed() -> UpdateResult<Installed> {
    let release = crate::managed_release::installed().map_err(|_| ERROR)?;
    let version = release.version.ok_or("update.bootstrap_required")?;
    let source_commit = release.source_commit.ok_or("update.bootstrap_required")?;
    nessie_executor_updater::catalog::compare_versions(&version, &version)?;
    if source_commit.len() != 40 || !source_commit.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err(ERROR); }
    Ok(Installed { version, source_commit })
}
pub(super) fn hash(path: &Path) -> UpdateResult<String> {
    let mut file = File::open(path).map_err(|_| ERROR)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 65_536];
    loop {
        let count = file.read(&mut buffer).map_err(|_| ERROR)?;
        if count == 0 { break; }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
pub(super) fn pin_worker(path: &Path) -> UpdateResult<File> {
    let directory = path.parent().ok_or(ERROR)?;
    let digest = directory.file_name().and_then(|name| name.to_str()).ok_or(ERROR)?;
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        || directory.parent() != Some(root()?.join("bin").as_path())
        || path.file_name().and_then(|name| name.to_str()) != Some("nessie-computer-updater") { return Err(ERROR); }
    admission_unix::directory(directory)?;
    let entry = fs::symlink_metadata(path).map_err(|_| ERROR)?;
    if !entry.is_file() || entry.file_type().is_symlink() || entry.uid() != 0 || entry.nlink() != 1
        || entry.mode() & 0o222 != 0 || entry.len() > 256 * 1024 * 1024 { return Err(ERROR); }
    let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path).map_err(|_| ERROR)?;
    let opened = file.metadata().map_err(|_| ERROR)?;
    if opened.ino() != entry.ino() || opened.dev() != entry.dev() || hash(path)? != digest { return Err(ERROR); }
    #[cfg(target_os = "macos")]
    crate::macos_provenance::require_file(path).map_err(|_| ERROR)?;
    Ok(file)
}
pub(super) fn worker_image() -> UpdateResult<PathBuf> {
    privileged()?;
    // Repair starts with the surviving protected reference when current files
    // are partial. A new coherent runtime advances that reference atomically.
    let store = Store::new(root()?);
    let release = match crate::managed_release::installed() {
        Ok(release) => release,
        Err(_) => {
            let path = root()?.join("bin").join(store.worker_reference()?).join("nessie-computer-updater");
            let _pin = pin_worker(&path)?;
            return Ok(path);
        },
    };
    let source = release.directory.join("nessie-executor-native");
    let digest = hash(&source)?;
    let bin = root()?.join("bin");
    directory(&bin)?;
    let folder = bin.join(&digest);
    directory(&folder)?;
    let output = folder.join("nessie-computer-updater");
    if !output.exists() {
        let draft = folder.join(format!(".worker-{}.draft", std::process::id()));
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o500)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&draft).map_err(|_| ERROR)?;
        let mut input = File::open(&source).map_err(|_| ERROR)?;
        std::io::copy(&mut input, &mut file).map_err(|_| ERROR)?;
        file.set_permissions(fs::Permissions::from_mode(0o555)).map_err(|_| ERROR)?;
        file.flush().and_then(|()| file.sync_all()).map_err(|_| ERROR)?;
        drop(file);
        fs::rename(&draft, &output).map_err(|_| ERROR)?;
        File::open(&folder).and_then(|file| file.sync_all()).map_err(|_| ERROR)?;
    }
    let _pin = pin_worker(&output)?;
    store.save_worker_reference(&digest)?;
    Ok(output)
}
pub(super) fn verify_worker() -> UpdateResult<()> {
    privileged()?;
    #[cfg(target_os = "linux")]
    let executable = fs::read_link("/proc/self/exe").map_err(|_| ERROR)?;
    #[cfg(target_os = "macos")]
    let executable = std::env::current_exe().map_err(|_| ERROR)?;
    let _pin = pin_worker(&executable)?;
    Ok(())
}
pub(super) fn initialize() -> UpdateResult<PathBuf> {
    privileged()?;
    let release = crate::managed_release::load().map_err(|_| ERROR)?;
    if release.source_commit.as_deref() != Some(env!("NESSIE_EXECUTOR_SOURCE_COMMIT")) { return Err(ERROR); }
    crate::managed_machine_barrier::install().map_err(|_| ERROR)?;
    directory(&root()?)?;
    let _admission = crate::managed_machine_barrier::MachineBarrier::acquire().map_err(|_| "update.admission_busy")?;
    // Re-publish verified state without clearing an existing replacement fence.
    admission_unix::write(&admission_unix::read()?)?;
    worker_image()
}
