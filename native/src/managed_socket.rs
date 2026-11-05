//! Filesystem probes stay inside the verified account namespace even when the
//! canonical home exceeds Linux's sockaddr_un pathname limit. The retained
//! directory descriptor is used only for bind/connect, not as runtime evidence.
use crate::protocol::NativeError;
use std::fs::{self, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;

fn refused() -> NativeError {
    NativeError::new("EXECUTOR_MANAGED_SOCKET_REJECTED")
}

fn with_address<T>(
    directory: &Path,
    name: &str,
    operation: impl FnOnce(&Path) -> std::io::Result<T>,
) -> Result<T, NativeError> {
    // These are generated process-generation names, never caller paths. Keep
    // the descriptor-relative address bounded and forbid traversal entirely.
    if name.len() > 64
        || !name.ends_with(".sock")
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.".contains(&byte))
        || name.contains("..")
    {
        return Err(refused());
    }
    let before = fs::symlink_metadata(directory).map_err(|_| refused())?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(directory)
        .map_err(|_| refused())?;
    let opened = file.metadata().map_err(|_| refused())?;
    let uid = unsafe { libc::getuid() };
    if !before.is_dir()
        || before.file_type().is_symlink()
        || opened.uid() != uid
        || opened.mode() & (if uid == 0 { 0o022 } else { 0o077 }) != 0
        || before.dev() != opened.dev()
        || before.ino() != opened.ino()
    {
        return Err(refused());
    }
    #[cfg(target_os = "linux")]
    let address = std::path::PathBuf::from(format!("/proc/self/fd/{}/{}", file.as_raw_fd(), name));
    // file remains open through the kernel lookup. The socket inode is still
    // published in directory; its permissions and SO_PEERCRED checks persist.
    #[cfg(target_os = "linux")]
    { operation(&address).map_err(|_| refused()) }
    #[cfg(target_os = "macos")]
    {
        // The standalone native helper has one thread. A descriptor-relative
        // lookup avoids sockaddr_un limits without accepting environment paths.
        let original = OpenOptions::new().read(true).custom_flags(libc::O_CLOEXEC).open(".")
            .map_err(|_| refused())?;
        if unsafe { libc::fchdir(file.as_raw_fd()) } != 0 { return Err(refused()); }
        let result = operation(Path::new(name));
        if unsafe { libc::fchdir(original.as_raw_fd()) } != 0 { return Err(refused()); }
        result.map_err(|_| refused())
    }
}

pub fn bind(directory: &Path, name: &str) -> Result<UnixListener, NativeError> {
    with_address(directory, name, |address| UnixListener::bind(address))
}

pub fn connect(directory: &Path, name: &str) -> Result<UnixStream, NativeError> {
    with_address(directory, name, |address| UnixStream::connect(address))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};

    #[test]
    fn long_private_home_socket_uses_the_same_filesystem_inode() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("a".repeat(80)).join("managed-runtimes");
        fs::create_dir_all(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let name = "01234567_123456-12345678901234567890.sock";
        let full = directory.join(name);
        assert!(full.as_os_str().len() > 107);
        assert!(UnixListener::bind(&full).is_err());
        let listener = bind(&directory, name).unwrap();
        assert!(fs::symlink_metadata(&full).unwrap().file_type().is_socket());
        let mut client = connect(&directory, name).unwrap();
        let (mut accepted, _) = listener.accept().unwrap();
        client.write_all(b"probe").unwrap();
        let mut bytes = [0_u8; 5];
        accepted.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"probe");
    }

    #[test]
    fn socket_namespace_rejects_mutability_symlinks_and_traversal() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("managed-runtimes");
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(bind(&directory, "test.sock").is_err());
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let linked = root.path().join("linked");
        std::os::unix::fs::symlink(&directory, &linked).unwrap();
        assert!(bind(&linked, "test.sock").is_err());
        for name in ["../test.sock", "a/b.sock", "x..sock", "x.sock "] {
            assert!(bind(&directory, name).is_err());
        }
    }
}
