use super::{digest, CONFLICT, IO, MAX_BYTES, REJECTED};
use crate::{personal_state_context, protocol::NativeError, state_security};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Component, Path, PathBuf};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, LockFileEx, MoveFileExW, UnlockFileEx, BY_HANDLE_FILE_INFORMATION,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, LOCKFILE_EXCLUSIVE_LOCK,
    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};
use windows_sys::Win32::System::IO::OVERLAPPED;

fn failure() -> NativeError {
    NativeError::new(IO)
}
fn rejected() -> NativeError {
    NativeError::new(REJECTED)
}
fn text(path: &Path) -> Result<&str, NativeError> {
    path.to_str().ok_or_else(rejected)
}
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

/// Hold every directory without FILE_SHARE_DELETE for the entire mutation.
/// Junction replacement/rename cannot change the namespace after it is checked.
fn pin(path: &Path, directory: bool) -> Result<File, NativeError> {
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| failure())?;
    let metadata = file.metadata().map_err(|_| failure())?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || metadata.is_dir() != directory
        || (!directory && !metadata.is_file())
    {
        return Err(rejected());
    }
    if !directory {
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &mut info) } == 0 {
            return Err(failure());
        }
        if info.nNumberOfLinks != 1 {
            return Err(rejected());
        }
    }
    Ok(file)
}

fn scoped_path(value: &str, allow_root: bool) -> Result<(PathBuf, PathBuf), NativeError> {
    let root = personal_state_context::protected_root()?;
    let path = PathBuf::from(value);
    let tail = path.strip_prefix(&root).map_err(|_| rejected())?;
    if !allow_root && tail.as_os_str().is_empty() {
        return Err(rejected());
    }
    for component in tail.components() {
        match component {
            Component::Normal(name) => {
                let value = name.to_str().ok_or_else(rejected)?;
                // Alternate streams, Windows-normalized aliases and reserved temp/lock names
                // are never state destinations supplied by the caller.
                if value.is_empty()
                    || value.contains(':')
                    || (value.ends_with('.') || value.ends_with(' '))
                    || value.starts_with(".mutation-")
                    || value.starts_with(".draft-")
                {
                    return Err(rejected());
                }
            }
            _ => return Err(rejected()),
        }
    }
    Ok((root, path))
}

fn secure_new_directory(path: &Path) -> Result<(), NativeError> {
    match std::fs::create_dir(path) {
        Ok(()) => state_security::secure_directory(text(path)?),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            state_security::verify_owner_only(text(path)?)
        }
        Err(_) => Err(failure()),
    }
}

fn pin_directories(root: &Path, target: &Path, create: bool) -> Result<Vec<File>, NativeError> {
    let nessie = root.parent().ok_or_else(rejected)?;
    let profile = nessie.parent().ok_or_else(rejected)?;
    let mut held = vec![pin(profile, true)?];
    let mut current = nessie.to_path_buf();
    let mut paths = vec![nessie.to_path_buf(), root.to_path_buf()];
    for component in target
        .strip_prefix(root)
        .map_err(|_| rejected())?
        .components()
    {
        current = if current == nessie {
            root.to_path_buf()
        } else {
            current
        };
        current.push(component.as_os_str());
        paths.push(current.clone());
    }
    for path in paths {
        if create {
            secure_new_directory(&path)?;
        }
        let handle = pin(&path, true)?;
        state_security::verify_owner_only(text(&path)?)?;
        held.push(handle);
    }
    Ok(held)
}

pub fn ensure_directory(value: &str) -> Result<(), NativeError> {
    let (root, path) = scoped_path(value, true)?;
    let _held = pin_directories(&root, &path, true)?;
    Ok(())
}

#[path = "windows_clearance.rs"]
mod clearance;
pub use clearance::verify_deletion;

struct MutationLock(File);
impl MutationLock {
    fn acquire(path: &Path) -> Result<Self, NativeError> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| failure())?;
        let _shape = pin(path, false)?;
        state_security::secure_owner_only_file(text(path)?)?;
        let mut overlap: OVERLAPPED = unsafe { std::mem::zeroed() };
        if unsafe {
            LockFileEx(
                file.as_raw_handle() as HANDLE,
                LOCKFILE_EXCLUSIVE_LOCK,
                0,
                u32::MAX,
                u32::MAX,
                &mut overlap,
            )
        } == 0
        {
            return Err(failure());
        }
        Ok(Self(file))
    }
}
impl Drop for MutationLock {
    fn drop(&mut self) {
        let mut overlap: OVERLAPPED = unsafe { std::mem::zeroed() };
        unsafe {
            UnlockFileEx(
                self.0.as_raw_handle() as HANDLE,
                0,
                u32::MAX,
                u32::MAX,
                &mut overlap,
            )
        };
    }
}

fn existing_digest(path: &Path) -> Result<Option<String>, NativeError> {
    if !path.try_exists().map_err(|_| failure())? {
        return Ok(None);
    }
    let _shape = pin(path, false)?;
    state_security::verify_owner_only_file(text(path)?)?;
    let mut file = File::open(path).map_err(|_| failure())?;
    if file.metadata().map_err(|_| failure())?.len() > MAX_BYTES {
        return Err(rejected());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failure())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(rejected());
    }
    Ok(Some(digest(&bytes)))
}

/// Only this destination's orphan draft is removed, under its kernel lock.
/// Deletion never moves credential bytes into a tombstone or recovery record.
fn remove_orphan(path: &Path) -> Result<(), NativeError> {
    if !path.try_exists().map_err(|_| failure())? {
        return Ok(());
    }
    {
        let _shape = pin(path, false)?;
        state_security::verify_owner_only_file(text(path)?)?;
    }
    std::fs::remove_file(path).map_err(|_| failure())
}

pub fn mutate(
    value: &str,
    expected: Option<&str>,
    bytes: Option<&[u8]>,
) -> Result<(), NativeError> {
    let (root, path) = scoped_path(value, false)?;
    mutate_scoped(&root, &path, expected, bytes)
}

fn mutate_scoped(
    root: &Path,
    path: &Path,
    expected: Option<&str>,
    bytes: Option<&[u8]>,
) -> Result<(), NativeError> {
    let parent = path.parent().ok_or_else(rejected)?;
    let _held = pin_directories(root, parent, false)?;
    let key = digest(
        path.file_name()
            .ok_or_else(rejected)?
            .to_string_lossy()
            .as_bytes(),
    );
    let _lock = MutationLock::acquire(&parent.join(".mutation-directory.lock"))?;
    let temporary = parent.join(format!(".draft-{key}"));
    remove_orphan(&temporary)?;
    if existing_digest(&path)?.as_deref() != expected {
        return Err(NativeError::new(CONFLICT));
    }
    match bytes {
        None => {
            if expected.is_none() {
                return Err(rejected());
            }
            std::fs::remove_file(&path).map_err(|_| failure())
        }
        Some(bytes) => {
            if bytes.len() as u64 > MAX_BYTES {
                return Err(rejected());
            }
            let outcome = (|| {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)
                    .map_err(|_| failure())?;
                state_security::secure_owner_only_file(text(&temporary)?)?;
                file.write_all(bytes).map_err(|_| failure())?;
                // Rust's Windows sync_all uses FlushFileBuffers on a GENERIC_WRITE
                // handle. No directory-fsync claim or elevated volume flush.
                file.sync_all().map_err(|_| failure())?;
                drop(file);
                state_security::verify_owner_only_file(text(&temporary)?)?;
                if unsafe {
                    MoveFileExW(
                        wide(&temporary).as_ptr(),
                        wide(&path).as_ptr(),
                        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                    )
                } == 0
                {
                    return Err(failure());
                }
                state_security::verify_owner_only_file(text(&path)?)?;
                Ok(())
            })();
            if outcome.is_err() {
                remove_orphan(&temporary)?;
            }
            outcome
        }
    }
}

/// Process-crash visibility barrier: serialize with every native publication,
/// remove abandoned drafts, and verify the actual namespace from held handles.
/// This is not a directory FlushFileBuffers or a power-loss assertion.
pub fn barrier(value: &str) -> Result<(), NativeError> {
    let (root, directory) = scoped_path(value, true)?;
    barrier_scoped(&root, &directory)
}

fn barrier_scoped(root: &Path, directory: &Path) -> Result<(), NativeError> {
    let _held = pin_directories(root, directory, false)?;
    let lock = MutationLock::acquire(&directory.join(".mutation-directory.lock"))?;
    for entry in std::fs::read_dir(directory).map_err(|_| failure())? {
        let entry = entry.map_err(|_| failure())?;
        let name = entry.file_name();
        let name = name.to_str().ok_or_else(rejected)?;
        let path = entry.path();
        if let Some(key) = name.strip_prefix(".draft-") {
            if key.len() != 64
                || !key
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            {
                return Err(rejected());
            }
            remove_orphan(&path)?;
        } else {
            let directory = entry.file_type().map_err(|_| failure())?.is_dir();
            let _shape = pin(&path, directory)?;
            if directory {
                state_security::verify_owner_only(text(&path)?)?;
            } else {
                state_security::verify_owner_only_file(text(&path)?)?;
            }
        }
    }
    lock.0.sync_all().map_err(|_| failure())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temporary = tempfile::tempdir().expect("fixture root");
        let root = temporary.path().join(".nessie").join("personal-inference");
        let directory = root.join("native-cas-fixture");
        pin_directories(&root, &directory, true).expect("owner-only directories");
        (temporary, root, directory)
    }
    #[test]
    fn native_cas_publication_conflict_and_deletion_observe_real_filesystem() {
        let (_temporary, root, directory) = fixture();
        let path = directory.join("state.json");
        mutate_scoped(&root, &path, None, Some(b"one")).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"one");
        assert_eq!(
            mutate_scoped(&root, &path, None, Some(b"wrong"))
                .unwrap_err()
                .code,
            CONFLICT
        );
        let first = digest(b"one");
        mutate_scoped(&root, &path, Some(&first), Some(b"two")).unwrap();
        mutate_scoped(&root, &path, Some(&digest(b"two")), None).unwrap();
        barrier_scoped(&root, &directory).unwrap();
        assert!(!path.exists());
    }
    #[test]
    fn concurrent_native_cas_has_one_winner_and_barrier_cleans_abandoned_draft() {
        let (_temporary, root, directory) = fixture();
        let path = directory.join("state.json");
        let orphan = directory.join(format!(".draft-{}", digest(b"old-destination")));
        std::fs::write(&orphan, b"revoked-fixture-bytes").unwrap();
        state_security::secure_owner_only_file(text(&orphan).unwrap()).unwrap();
        let writers: Vec<_> = (0..2)
            .map(|index| {
                let root = root.clone();
                let path = path.clone();
                std::thread::spawn(move || {
                    mutate_scoped(&root, &path, None, Some(&[index])).is_ok()
                })
            })
            .collect();
        assert_eq!(
            writers
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .filter(|won| *won)
                .count(),
            1
        );
        barrier_scoped(&root, &directory).unwrap();
        assert!(!orphan.exists());
    }
    #[test]
    fn hard_linked_state_is_rejected_before_mutation() {
        let (_temporary, root, directory) = fixture();
        let path = directory.join("state.json");
        mutate_scoped(&root, &path, None, Some(b"one")).unwrap();
        let alias = directory.join("alias.json");
        std::fs::hard_link(&path, &alias).expect("native filesystem must support NTFS hard links");
        assert_eq!(
            mutate_scoped(&root, &path, Some(&digest(b"one")), None)
                .unwrap_err()
                .code,
            REJECTED
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"one");
    }

    #[test]
    fn native_lock_crash_child() {
        let Some(value) = std::env::var_os("NESSIE_NATIVE_CAS_CRASH_FIXTURE") else {
            return;
        };
        let _lock = MutationLock::acquire(Path::new(&value)).unwrap();
        println!("LOCK_ACQUIRED");
        loop {
            std::thread::park();
        }
    }

    #[test]
    fn kernel_lock_is_released_after_process_death() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        let (_temporary, _root, directory) = fixture();
        let path = directory.join(".mutation-directory.lock");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "personal_state::imp::tests::native_lock_crash_child",
                "--nocapture",
            ])
            .env("NESSIE_NATIVE_CAS_CRASH_FIXTURE", &path)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let output = child.stdout.take().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                if matches!(line.as_deref(), Ok("LOCK_ACQUIRED")) {
                    let _ = send.send(());
                    return;
                }
            }
        });
        let acquired = receive
            .recv_timeout(std::time::Duration::from_secs(15))
            .is_ok();
        let killed = child.kill().is_ok();
        let exited = child.wait().is_ok();
        reader.join().unwrap();
        assert!(
            acquired && killed && exited,
            "child acquired kernel lock and was stopped"
        );
        let _recovered =
            MutationLock::acquire(&path).expect("kernel must release a dead process lock");
    }

    #[test]
    fn namespace_alias_and_unknown_context_fail_closed() {
        for path in [r"C:\foreign\state.json", r"C:\foreign\state.json:alternate"] {
            assert!(scoped_path(path, false).is_err());
        }
        // On elevated CI/SSH this is an explicit negative context proof; native
        // filesystem tests above do not assert an interactive activation passed.
        if personal_state_context::protected_root().is_err() {
            assert!(ensure_directory(r"C:\foreign").is_err());
        }
    }
}
