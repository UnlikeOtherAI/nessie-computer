use crate::preflight::{
    c_string, entry_stat, hash_file, open_directory_at, open_regular_file, ordinary_directory,
};
use crate::protocol::{DigestEntry, NativeError};
use std::ffi::CStr;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::MetadataExt;

const COPY_BUFFER_BYTES: usize = 65_536;

pub(crate) fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            matches!(index, 8 | 13 | 18 | 23) && byte == b'-' || byte.is_ascii_hexdigit()
        })
}

pub(crate) fn fsync_directory(fd: RawFd) -> Result<(), NativeError> {
    if unsafe { libc::fsync(fd) } != 0 {
        return Err(NativeError::new("EXECUTOR_PROMOTION_IO_FAILURE"));
    }
    Ok(())
}

fn controlled_directory(fd: RawFd, expected_device: u64) -> Result<OwnedFd, NativeError> {
    let (directory, device) = ordinary_directory(fd, Some(expected_device))?;
    let metadata = File::from(
        directory
            .try_clone()
            .map_err(|_| NativeError::new("EXECUTOR_PROMOTION_IO_FAILURE"))?,
    )
    .metadata()?;
    if device != expected_device
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o022 != 0
    {
        return Err(NativeError::new("EXECUTOR_PROMOTION_JOURNAL_INVALID"));
    }
    Ok(directory)
}

pub(crate) fn ensure_directory_at(
    parent: RawFd,
    name: &str,
    root_device: u64,
) -> Result<OwnedFd, NativeError> {
    let name_c = c_string(name)?;
    let created = unsafe { libc::mkdirat(parent, name_c.as_ptr(), 0o700) };
    if created != 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists {
        return Err(NativeError::new("EXECUTOR_PROMOTION_IO_FAILURE"));
    }
    let directory = open_directory_at(parent, name, root_device)?;
    controlled_directory(directory.as_raw_fd(), root_device)
}

pub(crate) fn create_directory_at(
    parent: RawFd,
    name: &str,
    root_device: u64,
) -> Result<OwnedFd, NativeError> {
    let name_c = c_string(name)?;
    if unsafe { libc::mkdirat(parent, name_c.as_ptr(), 0o700) } != 0 {
        return Err(NativeError::new("EXECUTOR_PROMOTION_JOURNAL_INVALID"));
    }
    let directory = open_directory_at(parent, name, root_device)?;
    controlled_directory(directory.as_raw_fd(), root_device)
}

pub(crate) fn ensure_nested_directory(
    root: RawFd,
    segments: &[&str],
    root_device: u64,
) -> Result<OwnedFd, NativeError> {
    let (mut directory, _) = ordinary_directory(root, Some(root_device))?;
    for segment in segments {
        directory = ensure_directory_at(directory.as_raw_fd(), segment, root_device)?;
    }
    Ok(directory)
}

pub(crate) fn write_new_file(parent: RawFd, name: &str, bytes: &[u8]) -> Result<(), NativeError> {
    let name = c_string(name)?;
    let descriptor = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(NativeError::new("EXECUTOR_PROMOTION_JOURNAL_INVALID"));
    }
    let mut file = unsafe { File::from_raw_fd(descriptor) };
    file.write_all(bytes)?;
    file.sync_all()?;
    fsync_directory(parent)
}

pub(crate) fn read_regular_file(
    parent: RawFd,
    name: &str,
    root_device: u64,
) -> Result<Vec<u8>, NativeError> {
    let name = c_string(name)?;
    let mut file = open_regular_file(parent, &name, root_device)?;
    let metadata = file.metadata()?;
    if metadata.len() > 128 * 1024 {
        return Err(NativeError::new("EXECUTOR_PROMOTION_JOURNAL_INVALID"));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

pub(crate) fn copy_file(
    source_parent: RawFd,
    source_name: &str,
    source_device: u64,
    destination_parent: RawFd,
    destination_name: &str,
    expected: &DigestEntry,
) -> Result<(), NativeError> {
    let source_name = c_string(source_name)?;
    if !crate::preflight::same_entry(
        &hash_file(open_regular_file(
            source_parent,
            &source_name,
            source_device,
        )?)?,
        expected,
    ) {
        return Err(NativeError::new("EXECUTOR_PROMOTION_CONFLICT"));
    }
    let mut source = open_regular_file(source_parent, &source_name, source_device)?;
    let destination_name = c_string(destination_name)?;
    let descriptor = unsafe {
        libc::openat(
            destination_parent,
            destination_name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(NativeError::new("EXECUTOR_PROMOTION_JOURNAL_INVALID"));
    }
    let mut destination = unsafe { File::from_raw_fd(descriptor) };
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        destination.write_all(&buffer[..count])?;
    }
    destination.sync_all()?;
    fsync_directory(destination_parent)
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn renameatx_np(
        fromfd: libc::c_int,
        from: *const libc::c_char,
        tofd: libc::c_int,
        to: *const libc::c_char,
        flags: libc::c_uint,
    ) -> libc::c_int;
}

pub(crate) fn rename_without_replace(
    source_parent: RawFd,
    source_name: &str,
    destination_parent: RawFd,
    destination_name: &str,
) -> Result<(), NativeError> {
    let source_name = c_string(source_name)?;
    let destination_name = c_string(destination_name)?;
    #[cfg(target_os = "macos")]
    let result = unsafe {
        renameatx_np(
            source_parent,
            source_name.as_ptr(),
            destination_parent,
            destination_name.as_ptr(),
            0x0000_0004,
        )
    };
    #[cfg(not(target_os = "macos"))]
    let result = unsafe {
        if entry_stat(destination_parent, &destination_name)?.is_some() {
            return Err(NativeError::new("EXECUTOR_PROMOTION_CONFLICT"));
        }
        libc::renameat(
            source_parent,
            source_name.as_ptr(),
            destination_parent,
            destination_name.as_ptr(),
        )
    };
    if result != 0 {
        return Err(NativeError::new("EXECUTOR_PROMOTION_CONFLICT"));
    }
    fsync_directory(source_parent)?;
    if source_parent != destination_parent {
        fsync_directory(destination_parent)?;
    }
    Ok(())
}

pub(crate) fn remove_file_if_matches(
    parent: RawFd,
    name: &str,
    root_device: u64,
    expected: &DigestEntry,
) -> Result<(), NativeError> {
    let name_c = c_string(name)?;
    if entry_stat(parent, &name_c)?.is_none() {
        return Ok(());
    }
    if !crate::preflight::same_entry(
        &hash_file(open_regular_file(parent, &name_c, root_device)?)?,
        expected,
    ) {
        return Err(NativeError::new("EXECUTOR_PROMOTION_RECOVERY_REQUIRED"));
    }
    if unsafe { libc::unlinkat(parent, name_c.as_ptr(), 0) } != 0 {
        return Err(NativeError::new("EXECUTOR_PROMOTION_RECOVERY_REQUIRED"));
    }
    fsync_directory(parent)
}

pub(crate) fn directory_entries(fd: RawFd) -> Result<Vec<String>, NativeError> {
    let duplicated = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
    if duplicated < 0 {
        return Err(NativeError::new("EXECUTOR_PROMOTION_IO_FAILURE"));
    }
    let directory = unsafe { libc::fdopendir(duplicated) };
    if directory.is_null() {
        unsafe { libc::close(duplicated) };
        return Err(NativeError::new("EXECUTOR_PROMOTION_IO_FAILURE"));
    }
    let mut entries = Vec::new();
    loop {
        let entry = unsafe { libc::readdir(directory) };
        if entry.is_null() {
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }
            .to_str()
            .map_err(|_| NativeError::new("EXECUTOR_PROMOTION_JOURNAL_INVALID"))?;
        if name != "." && name != ".." {
            entries.push(name.to_owned());
        }
    }
    unsafe { libc::closedir(directory) };
    Ok(entries)
}
