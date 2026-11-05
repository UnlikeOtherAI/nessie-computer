use crate::protocol::{
    Change, ChangeKind, DigestEntry, NativeError, PreflightRequest, MAX_CHANGES, MAX_PATH_LENGTH,
    MAX_REQUEST_BYTES, PROTOCOL_VERSION,
};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

const JOURNAL_DIRECTORY: &str = ".nessie-executor-promotions";

pub(crate) fn is_sha256(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(*byte, b'a'..=b'f'))
}

pub(crate) fn path_segments(path: &str) -> Result<Vec<&str>, NativeError> {
    if path.is_empty()
        || path.len() > MAX_PATH_LENGTH
        || path.as_bytes().contains(&0)
        || Path::new(path).is_absolute()
    {
        return Err(NativeError::new("EXECUTOR_PROMOTION_UNSAFE_PATH"));
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments.is_empty()
        || segments.iter().any(|segment| {
            segment.is_empty()
                || *segment == "."
                || *segment == ".."
                || segment.as_bytes().contains(&0)
        })
        || segments[0] == JOURNAL_DIRECTORY
    {
        return Err(NativeError::new("EXECUTOR_PROMOTION_UNSAFE_PATH"));
    }
    Ok(segments)
}

pub(crate) fn c_string(value: &str) -> Result<CString, NativeError> {
    CString::new(value).map_err(|_| NativeError::new("EXECUTOR_PROMOTION_UNSAFE_PATH"))
}

pub(crate) fn duplicate(fd: RawFd) -> Result<OwnedFd, NativeError> {
    let next = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
    if next < 0 {
        return Err(NativeError::new("EXECUTOR_PROMOTION_IO_FAILURE"));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(next) })
}

pub(crate) fn ordinary_directory(
    fd: RawFd,
    root_device: Option<u64>,
) -> Result<(OwnedFd, u64), NativeError> {
    let descriptor = duplicate(fd)?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    if unsafe { libc::fstat(descriptor.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(NativeError::new("EXECUTOR_PROMOTION_IO_FAILURE"));
    }
    let stat = unsafe { stat.assume_init() };
    if (stat.st_mode & libc::S_IFMT) != libc::S_IFDIR {
        return Err(NativeError::new("EXECUTOR_PROMOTION_UNSAFE_ROOT"));
    }
    let device = stat.st_dev as u64;
    if root_device.is_some_and(|expected| expected != device) {
        return Err(NativeError::new("EXECUTOR_PROMOTION_UNSAFE_PATH"));
    }
    Ok((descriptor, device))
}

pub(crate) fn open_directory_at(
    parent: RawFd,
    name: &str,
    root_device: u64,
) -> Result<OwnedFd, NativeError> {
    let name = c_string(name)?;
    let descriptor = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(NativeError::new("EXECUTOR_PROMOTION_UNSAFE_PATH"));
    }
    let descriptor = unsafe { OwnedFd::from_raw_fd(descriptor) };
    let (_, device) = ordinary_directory(descriptor.as_raw_fd(), Some(root_device))?;
    if device != root_device {
        return Err(NativeError::new("EXECUTOR_PROMOTION_UNSAFE_PATH"));
    }
    Ok(descriptor)
}

pub(crate) fn open_parent(
    root: RawFd,
    segments: &[&str],
    root_device: u64,
) -> Result<(OwnedFd, CString), NativeError> {
    let (mut directory, _) = ordinary_directory(root, Some(root_device))?;
    for segment in &segments[..segments.len() - 1] {
        directory = open_directory_at(directory.as_raw_fd(), segment, root_device)?;
    }
    Ok((directory, c_string(segments[segments.len() - 1])?))
}

pub(crate) fn entry_stat(parent: RawFd, name: &CString) -> Result<Option<libc::stat>, NativeError> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    let result = unsafe {
        libc::fstatat(
            parent,
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == 0 {
        return Ok(Some(unsafe { stat.assume_init() }));
    }
    if io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
        return Ok(None);
    }
    Err(NativeError::new("EXECUTOR_PROMOTION_IO_FAILURE"))
}

pub(crate) fn open_regular_file(
    parent: RawFd,
    name: &CString,
    root_device: u64,
) -> Result<File, NativeError> {
    let descriptor = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(NativeError::new("EXECUTOR_PROMOTION_UNSAFE_PATH"));
    }
    let file = unsafe { File::from_raw_fd(descriptor) };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.dev() != root_device {
        return Err(NativeError::new("EXECUTOR_PROMOTION_UNSAFE_PATH"));
    }
    Ok(file)
}

pub(crate) fn hash_file(mut file: File) -> Result<DigestEntry, NativeError> {
    let metadata = file.metadata()?;
    let mut hasher = Sha256::new();
    let mut bytes = [0_u8; 65_536];
    loop {
        let count = file.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        hasher.update(&bytes[..count]);
    }
    Ok(DigestEntry {
        byte_count: metadata.len(),
        digest: format!("sha256:{:x}", hasher.finalize()),
    })
}

pub(crate) fn same_entry(actual: &DigestEntry, expected: &DigestEntry) -> bool {
    actual.byte_count == expected.byte_count && actual.digest == expected.digest
}

pub(crate) fn validate_change_shape(change: &Change) -> Result<(), NativeError> {
    match change.kind {
        ChangeKind::Created if change.base.is_none() && change.draft.is_some() => Ok(()),
        ChangeKind::Modified if change.base.is_some() && change.draft.is_some() => Ok(()),
        ChangeKind::Deleted if change.base.is_some() && change.draft.is_none() => Ok(()),
        _ => Err(NativeError::new("EXECUTOR_PROMOTION_MANIFEST_INVALID")),
    }
}

pub(crate) fn check_expected(entry: &DigestEntry) -> Result<(), NativeError> {
    if !is_sha256(&entry.digest) {
        return Err(NativeError::new("EXECUTOR_PROMOTION_MANIFEST_INVALID"));
    }
    Ok(())
}

fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {
            value.to_string()
        }
        serde_json::Value::String(_) => {
            serde_json::to_string(value).expect("string is serializable")
        }
        serde_json::Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        serde_json::Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("object key is serializable"),
                        canonical_json(&values[key]),
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

pub(crate) fn manifest_digest(request: &PreflightRequest) -> Result<String, NativeError> {
    let payload = serde_json::json!({
        "changes": request.changes,
        "protocolVersion": request.protocol_version,
        "runId": request.run_id,
    });
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(canonical_json(&payload).as_bytes())
    ))
}

pub(crate) fn validate_manifest_request(request: &PreflightRequest) -> Result<(), NativeError> {
    if request.protocol_version != PROTOCOL_VERSION
        || request.changes.len() > MAX_CHANGES
        || !is_sha256(&request.manifest_digest)
        || manifest_digest(request)? != request.manifest_digest
    {
        return Err(NativeError::new("EXECUTOR_PROMOTION_MANIFEST_INVALID"));
    }
    Ok(())
}

pub fn preflight(
    root_fd: RawFd,
    draft_fd: RawFd,
    request: &PreflightRequest,
) -> Result<(), NativeError> {
    validate_manifest_request(request)?;
    let (_, root_device) = ordinary_directory(root_fd, None)?;
    let (_, draft_device) = ordinary_directory(draft_fd, None)?;
    let mut paths = HashSet::with_capacity(request.changes.len());
    for change in &request.changes {
        validate_change_shape(change)?;
        let segments = path_segments(&change.path)?;
        if !paths.insert(change.path.as_str()) {
            return Err(NativeError::new("EXECUTOR_PROMOTION_MANIFEST_INVALID"));
        }
        if let Some(base) = &change.base {
            check_expected(base)?;
        }
        if let Some(draft) = &change.draft {
            check_expected(draft)?;
        }
        let (host_parent, host_name) = open_parent(root_fd, &segments, root_device)?;
        let host_stat = entry_stat(host_parent.as_raw_fd(), &host_name)?;
        match (&change.kind, host_stat) {
            (ChangeKind::Created, None) => {}
            (ChangeKind::Created, Some(_)) => {
                return Err(NativeError::new("EXECUTOR_PROMOTION_CONFLICT"))
            }
            (_, None) => return Err(NativeError::new("EXECUTOR_PROMOTION_CONFLICT")),
            (_, Some(stat))
                if (stat.st_mode & libc::S_IFMT) != libc::S_IFREG || stat.st_nlink != 1 =>
            {
                return Err(NativeError::new("EXECUTOR_PROMOTION_UNSAFE_PATH"));
            }
            (_, Some(_)) => {
                let actual = hash_file(open_regular_file(
                    host_parent.as_raw_fd(),
                    &host_name,
                    root_device,
                )?)?;
                if !same_entry(&actual, change.base.as_ref().expect("validated base")) {
                    return Err(NativeError::new("EXECUTOR_PROMOTION_CONFLICT"));
                }
            }
        }
        if !matches!(change.kind, ChangeKind::Deleted) {
            let (draft_parent, draft_name) = open_parent(draft_fd, &segments, draft_device)?;
            let actual = hash_file(open_regular_file(
                draft_parent.as_raw_fd(),
                &draft_name,
                draft_device,
            )?)?;
            if !same_entry(&actual, change.draft.as_ref().expect("validated draft")) {
                return Err(NativeError::new("EXECUTOR_PROMOTION_CONFLICT"));
            }
        }
    }
    Ok(())
}

pub fn read_request() -> Result<PreflightRequest, NativeError> {
    let mut input = String::new();
    io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_string(&mut input)?;
    if input.len() as u64 > MAX_REQUEST_BYTES {
        return Err(NativeError::new("EXECUTOR_PROMOTION_MANIFEST_INVALID"));
    }
    serde_json::from_str(&input)
        .map_err(|_| NativeError::new("EXECUTOR_PROMOTION_MANIFEST_INVALID"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};

    fn digest_path(path: &Path) -> DigestEntry {
        hash_file(File::open(path).expect("open fixture")).expect("hash fixture")
    }

    #[test]
    fn rejects_unsafe_relative_paths() {
        for path in [
            "",
            ".",
            "../host",
            "nested/../host",
            "/host",
            "nested//file",
            ".nessie-executor-promotions/transaction",
        ] {
            assert_eq!(
                path_segments(path).unwrap_err().code,
                "EXECUTOR_PROMOTION_UNSAFE_PATH"
            );
        }
        assert_eq!(path_segments("nested/file").unwrap(), ["nested", "file"]);
    }

    #[test]
    fn requires_consistent_change_shapes() {
        let entry = DigestEntry {
            byte_count: 1,
            digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                .to_owned(),
        };
        assert!(validate_change_shape(&Change {
            base: None,
            draft: Some(entry),
            kind: ChangeKind::Created,
            path: "file".to_owned()
        })
        .is_ok());
        assert_eq!(
            validate_change_shape(&Change {
                base: None,
                draft: None,
                kind: ChangeKind::Modified,
                path: "file".to_owned()
            })
            .unwrap_err()
            .code,
            "EXECUTOR_PROMOTION_MANIFEST_INVALID"
        );
    }

    #[test]
    fn verifies_the_live_host_and_draft_from_directory_descriptors() {
        let root = tempfile::tempdir().expect("host root");
        let draft = tempfile::tempdir().expect("draft root");
        let host_file = root.path().join("file.txt");
        let draft_file = draft.path().join("file.txt");
        fs::write(&host_file, "base").expect("write host fixture");
        fs::write(&draft_file, "draft").expect("write draft fixture");
        let mut request = PreflightRequest {
            changes: vec![Change {
                base: Some(digest_path(&host_file)),
                draft: Some(digest_path(&draft_file)),
                kind: ChangeKind::Modified,
                path: "file.txt".to_owned(),
            }],
            manifest_digest: String::new(),
            protocol_version: PROTOCOL_VERSION,
            run_id: "00000000-0000-4000-8000-000000000001".to_owned(),
        };
        request.manifest_digest = manifest_digest(&request).expect("manifest digest");
        let root_descriptor = File::open(root.path()).expect("open host descriptor");
        let draft_descriptor = File::open(draft.path()).expect("open draft descriptor");
        assert!(preflight(
            root_descriptor.as_raw_fd(),
            draft_descriptor.as_raw_fd(),
            &request
        )
        .is_ok());

        fs::write(&host_file, "changed since review").expect("change host fixture");
        assert_eq!(
            preflight(
                root_descriptor.as_raw_fd(),
                draft_descriptor.as_raw_fd(),
                &request
            )
            .unwrap_err()
            .code,
            "EXECUTOR_PROMOTION_CONFLICT"
        );
    }

    #[test]
    fn accepts_the_camel_case_manifest_contract() {
        let request = serde_json::from_str::<PreflightRequest>(
            r#"{
              "changes": [{
                "base": {"byteCount": 4, "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"},
                "draft": {"byteCount": 5, "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111"},
                "kind": "modified",
                "path": "file.txt"
              }],
              "manifestDigest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
              "protocolVersion": 1,
              "runId": "00000000-0000-4000-8000-000000000001"
            }"#,
        )
        .expect("camel-case manifest parses");
        assert_eq!(request.changes[0].base.as_ref().unwrap().byte_count, 4);
        assert_eq!(request.run_id, "00000000-0000-4000-8000-000000000001");
        assert_eq!(
            manifest_digest(&request).expect("manifest digest"),
            "sha256:6adbddd77405df078a33a79bdae1673e99b822fe64925033765279146e92edc5"
        );
    }
}
