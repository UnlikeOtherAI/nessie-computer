//! Copy as nobody, then seal a private Root snapshot before trusting any payload.
use super::{admission_unix, unix_runtime::{self, ERROR}};
use nessie_executor_updater::catalog::UpdateResult;
use std::{ffi::CString, fs::{self, File}, os::unix::{ffi::OsStrExt,
    fs::{DirBuilderExt, MetadataExt, PermissionsExt}, process::CommandExt}, path::{Path, PathBuf},
    process::{Command, Stdio}, time::{Duration, Instant}};

fn nobody() -> UpdateResult<(u32, u32)> {
    let mut record: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result = std::ptr::null_mut();
    let mut buffer = vec![0_i8; 65_536];
    if unsafe { libc::getpwnam_r(c"nobody".as_ptr(), &mut record, buffer.as_mut_ptr(), buffer.len(), &mut result) } != 0
        || result.is_null() || record.pw_uid == 0 || record.pw_gid == 0 { return Err(ERROR); }
    Ok((record.pw_uid, record.pw_gid))
}

fn within_budget(path: &Path, nodes: &mut u32, bytes: &mut u64, depth: u32) -> UpdateResult<()> {
    *nodes += 1;
    if *nodes > 4096 || depth > 64 { return Err("update.invalid_package"); }
    let entry = fs::symlink_metadata(path).map_err(|_| ERROR)?;
    if entry.is_dir() {
        for child in fs::read_dir(path).map_err(|_| ERROR)? {
            within_budget(&child.map_err(|_| ERROR)?.path(), nodes, bytes, depth + 1)?;
        }
    } else if entry.is_file() {
        *bytes = bytes.checked_add(entry.len()).ok_or(ERROR)?;
        if entry.len() > 268_435_456 || *bytes > 1_073_741_824 { return Err("update.invalid_package"); }
    } else if !entry.file_type().is_symlink() { return Err("update.invalid_package"); }
    Ok(())
}

fn freeze(path: &Path, app: &Path, depth: u32) -> UpdateResult<()> {
    if depth > 64 { return Err(ERROR); }
    let entry = fs::symlink_metadata(path).map_err(|_| ERROR)?;
    let name = CString::new(path.as_os_str().as_bytes()).map_err(|_| ERROR)?;
    // Never chmod through a symlink. Framework links must stay inside this
    // snapshot, and no unprivileged writer can reach its private parent.
    if entry.file_type().is_symlink() {
        if !fs::canonicalize(path).map_err(|_| ERROR)?.starts_with(app) { return Err(ERROR); }
        if unsafe { libc::lchown(name.as_ptr(), 0, 0) } != 0 { return Err(ERROR); }
        return Ok(());
    }
    if !entry.is_dir() && (!entry.is_file() || entry.nlink() != 1) { return Err(ERROR); }
    if unsafe { libc::lchown(name.as_ptr(), 0, 0) } != 0 { return Err(ERROR); }
    if entry.is_dir() {
        for child in fs::read_dir(path).map_err(|_| ERROR)? {
            freeze(&child.map_err(|_| ERROR)?.path(), app, depth + 1)?;
        }
    }
    let mode = if entry.is_dir() || entry.mode() & 0o111 != 0 { 0o555 } else { 0o444 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|_| ERROR)?;
    File::open(path).and_then(|file| file.sync_all()).map_err(|_| ERROR)
}

pub(super) fn capture(source: &Path, key: &str) -> UpdateResult<PathBuf> {
    unix_runtime::privileged()?;
    if key.len() != 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err(ERROR); }
    let root = super::host::root()?.join("application-snapshots");
    match fs::symlink_metadata(&root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            admission_unix::directory(root.parent().ok_or(ERROR)?)?;
            fs::DirBuilder::new().mode(0o700).create(&root).map_err(|_| ERROR)?;
        },
        Ok(entry) if entry.is_dir() && entry.uid() == 0 && entry.mode() & 0o077 == 0 => {},
        _ => return Err(ERROR),
    }
    admission_unix::directory(&root)?;
    let cached = root.join(key);
    if let Ok(entry) = fs::symlink_metadata(&cached) {
        if !entry.is_dir() || entry.file_type().is_symlink() || entry.uid() != 0 || entry.mode() & 0o077 != 0 {
            return Err(ERROR);
        }
        let app = cached.join("Nessie Executor.app");
        crate::macos_provenance::require_updater_app(&app).map_err(|_| ERROR)?;
        return Ok(app);
    }
    let name = CString::new(root.as_os_str().as_bytes()).map_err(|_| ERROR)?;
    let mut space: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(name.as_ptr(), &mut space) } != 0
        || (space.f_bavail as u64).saturating_mul(space.f_frsize as u64) < 2_147_483_648 {
        return Err("update.insufficient_space");
    }
    let mut random = [0_u8; 16];
    unsafe { libc::arc4random_buf(random.as_mut_ptr().cast(), random.len()); }
    let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let directory = root.join(nonce);
    fs::DirBuilder::new().mode(0o700).create(&directory).map_err(|_| ERROR)?;
    let (uid, gid) = nobody()?;
    let destination = CString::new(directory.as_os_str().as_bytes()).map_err(|_| ERROR)?;
    if unsafe { libc::chown(destination.as_ptr(), uid, gid) } != 0 { return Err(ERROR); }
    let mut command = Command::new("/usr/bin/ditto");
    command.args(["--noacl", "--noqtn"]).arg(source).arg("Nessie Executor.app")
        .env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // Only the child drops privileges. Its working directory is reachable
    // through the retained cwd, while its Root-only parent blocks other users.
    unsafe { command.pre_exec(move || {
        if libc::chdir(destination.as_ptr()) != 0 || libc::setgroups(0, std::ptr::null()) != 0
            || libc::setgid(gid) != 0 || libc::setuid(uid) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let limit = libc::rlimit { rlim_cur: 268_435_456, rlim_max: 268_435_456 };
        if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) != 0 { return Err(std::io::Error::last_os_error()); }
        Ok(())
    }); }
    let mut child = command.spawn().map_err(|_| ERROR)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => break if status.success() { Ok(()) } else { Err("update.bundle_copy_failed") },
            Err(_) => break Err("update.bundle_copy_failed"),
            _ => {},
        }
        if Instant::now() >= deadline || within_budget(&directory, &mut 0, &mut 0, 0).is_err() {
            break Err("update.bundle_copy_failed");
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    if outcome.is_err() { let _ = child.kill(); let _ = child.wait(); }
    let name = CString::new(directory.as_os_str().as_bytes()).map_err(|_| ERROR)?;
    if unsafe { libc::chown(name.as_ptr(), 0, 0) } != 0 { return Err(ERROR); }
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(|_| ERROR)?;
    outcome?;
    within_budget(&directory, &mut 0, &mut 0, 0)?;
    let app = directory.join("Nessie Executor.app");
    freeze(&app, &app, 0)?;
    crate::macos_provenance::require_updater_app(&app).map_err(|_| ERROR)?;
    fs::rename(&directory, &cached).map_err(|_| ERROR)?;
    File::open(&root).and_then(|file| file.sync_all()).map_err(|_| ERROR)?;
    Ok(cached.join("Nessie Executor.app"))
}

/// Only a frozen Root snapshot is eligible for this privileged copy. Its
/// internal symlinks were already confined before the seal was accepted.
pub(super) fn clone_verified(source: &Path) -> UpdateResult<PathBuf> {
    unix_runtime::privileged()?;
    let root = super::host::root()?.join("application-snapshots");
    let container = source.parent().ok_or(ERROR)?;
    let key = container.file_name().and_then(|name| name.to_str()).ok_or(ERROR)?;
    if container.parent() != Some(root.as_path()) || key.len() != 64
        || !key.bytes().all(|byte| byte.is_ascii_hexdigit())
        || source.file_name().and_then(|name| name.to_str()) != Some("Nessie Executor.app") { return Err(ERROR); }
    admission_unix::directory(container)?;
    crate::macos_provenance::require_updater_app(source).map_err(|_| ERROR)?;
    let mut random = [0_u8; 16];
    unsafe { libc::arc4random_buf(random.as_mut_ptr().cast(), random.len()); }
    let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let directory = root.join(format!("replace-{nonce}"));
    fs::DirBuilder::new().mode(0o700).create(&directory).map_err(|_| ERROR)?;
    let app = directory.join("Nessie Executor.app");
    let status = Command::new("/usr/bin/ditto").args(["--noacl", "--noqtn"])
        .arg(source).arg(&app).env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_| ERROR)?;
    if !status.success() { return Err("update.bundle_copy_failed"); }
    freeze(&app, &app, 0)?;
    crate::macos_provenance::require_updater_app(&app).map_err(|_| ERROR)?;
    Ok(app)
}
