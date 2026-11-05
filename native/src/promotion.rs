use crate::preflight::{
    c_string, entry_stat, is_sha256, open_directory_at, open_parent, ordinary_directory,
    path_segments, preflight, validate_manifest_request,
};
use crate::promotion_fs::{
    copy_file, create_directory_at, directory_entries, ensure_directory_at,
    ensure_nested_directory, fsync_directory, read_regular_file, remove_file_if_matches,
    rename_without_replace, valid_uuid, write_new_file,
};
use crate::protocol::{NativeError, PromotionRequest};
use std::io::{Read, Take};
use std::os::fd::{AsRawFd, OwnedFd, RawFd};

const JOURNAL_DIRECTORY: &str = ".nessie-executor-promotions";
const JOURNAL_REQUEST: &str = "request.json";
const JOURNAL_COMMITTED: &str = "committed";
const JOURNAL_BACKUP: &str = "backup";
const JOURNAL_STAGE: &str = "stage";
const MAX_REQUEST_BYTES: u64 = 128 * 1024;

fn valid_fence(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

pub fn read_promotion_request() -> Result<PromotionRequest, NativeError> {
    let mut input = String::new();
    let mut limited: Take<std::io::Stdin> = std::io::stdin().take(MAX_REQUEST_BYTES + 1);
    limited.read_to_string(&mut input)?;
    if input.len() as u64 > MAX_REQUEST_BYTES {
        return Err(NativeError::new("EXECUTOR_PROMOTION_MANIFEST_INVALID"));
    }
    serde_json::from_str(&input)
        .map_err(|_| NativeError::new("EXECUTOR_PROMOTION_MANIFEST_INVALID"))
}

fn request_bytes(request: &PromotionRequest) -> Result<Vec<u8>, NativeError> {
    serde_json::to_vec(request).map_err(|_| NativeError::new("EXECUTOR_PROMOTION_JOURNAL_INVALID"))
}

fn read_journal_request(
    transaction: RawFd,
    root_device: u64,
) -> Result<PromotionRequest, NativeError> {
    let bytes = read_regular_file(transaction, JOURNAL_REQUEST, root_device)?;
    serde_json::from_slice(&bytes)
        .map_err(|_| NativeError::new("EXECUTOR_PROMOTION_JOURNAL_INVALID"))
}

fn validate_promotion_request(request: &PromotionRequest) -> Result<(), NativeError> {
    validate_manifest_request(&request.manifest())?;
    if !is_sha256(&request.approval_digest)
        || !valid_fence(&request.binding_fence)
        || !valid_uuid(&request.promotion_id)
    {
        return Err(NativeError::new("EXECUTOR_PROMOTION_MANIFEST_INVALID"));
    }
    Ok(())
}

fn journal_child_parent(
    transaction: RawFd,
    category: &str,
    path: &str,
    root_device: u64,
) -> Result<(OwnedFd, String), NativeError> {
    let segments = path_segments(path)?;
    let mut parents = Vec::with_capacity(segments.len());
    parents.push(category);
    parents.extend_from_slice(&segments[..segments.len() - 1]);
    let parent = ensure_nested_directory(transaction, &parents, root_device)?;
    Ok((parent, segments[segments.len() - 1].to_owned()))
}

fn rollback_changes(
    root: RawFd,
    transaction: RawFd,
    root_device: u64,
    request: &PromotionRequest,
) -> Result<(), NativeError> {
    for change in request.changes.iter().rev() {
        let segments = path_segments(&change.path)?;
        let (host_parent, host_name) = open_parent(root, &segments, root_device)?;
        let (backup_parent, backup_name) =
            journal_child_parent(transaction, JOURNAL_BACKUP, &change.path, root_device)?;
        let backup_exists =
            entry_stat(backup_parent.as_raw_fd(), &c_string(&backup_name)?)?.is_some();
        if change.base.is_some() && backup_exists {
            match &change.draft {
                Some(draft) => remove_file_if_matches(
                    host_parent.as_raw_fd(),
                    host_name.to_str().expect("validated path"),
                    root_device,
                    draft,
                )?,
                None if entry_stat(host_parent.as_raw_fd(), &host_name)?.is_some() => {
                    return Err(NativeError::new("EXECUTOR_PROMOTION_RECOVERY_REQUIRED"));
                }
                None => {}
            }
            rename_without_replace(
                backup_parent.as_raw_fd(),
                &backup_name,
                host_parent.as_raw_fd(),
                host_name.to_str().expect("validated path"),
            )?;
        } else if let Some(draft) = &change.draft {
            remove_file_if_matches(
                host_parent.as_raw_fd(),
                host_name.to_str().expect("validated path"),
                root_device,
                draft,
            )?;
        }
    }
    Ok(())
}

fn remove_empty_directory(parent: RawFd, name: &str) -> Result<(), NativeError> {
    let name = c_string(name)?;
    let status = unsafe { libc::unlinkat(parent, name.as_ptr(), libc::AT_REMOVEDIR) };
    if status != 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound {
        return Err(NativeError::new("EXECUTOR_PROMOTION_JOURNAL_INVALID"));
    }
    fsync_directory(parent)
}

fn remove_journal_tree(parent: RawFd, name: &str, root_device: u64) -> Result<(), NativeError> {
    let name_c = c_string(name)?;
    let Some(stat) = entry_stat(parent, &name_c)? else {
        return Ok(());
    };
    if (stat.st_mode & libc::S_IFMT) == libc::S_IFREG {
        if unsafe { libc::unlinkat(parent, name_c.as_ptr(), 0) } != 0 {
            return Err(NativeError::new("EXECUTOR_PROMOTION_JOURNAL_INVALID"));
        }
        return Ok(());
    }
    if (stat.st_mode & libc::S_IFMT) != libc::S_IFDIR {
        return Err(NativeError::new("EXECUTOR_PROMOTION_JOURNAL_INVALID"));
    }
    let directory = open_directory_at(parent, name, root_device)?;
    for child in directory_entries(directory.as_raw_fd())? {
        remove_journal_tree(directory.as_raw_fd(), &child, root_device)?;
    }
    remove_empty_directory(parent, name)
}

fn recover_transaction(
    root: RawFd,
    journal: RawFd,
    transaction_name: &str,
    root_device: u64,
) -> Result<(), NativeError> {
    let transaction = open_directory_at(journal, transaction_name, root_device)?;
    let committed = entry_stat(transaction.as_raw_fd(), &c_string(JOURNAL_COMMITTED)?)?.is_some();
    if !committed {
        let request = read_journal_request(transaction.as_raw_fd(), root_device)?;
        validate_promotion_request(&request)?;
        if request.promotion_id != transaction_name {
            return Err(NativeError::new("EXECUTOR_PROMOTION_JOURNAL_INVALID"));
        }
        rollback_changes(root, transaction.as_raw_fd(), root_device, &request)?;
    }
    remove_journal_tree(journal, transaction_name, root_device)
}

fn recover_journals(root: RawFd, journal: RawFd, root_device: u64) -> Result<(), NativeError> {
    for transaction_name in directory_entries(journal)? {
        if !valid_uuid(&transaction_name) {
            return Err(NativeError::new("EXECUTOR_PROMOTION_JOURNAL_INVALID"));
        }
        recover_transaction(root, journal, &transaction_name, root_device)?;
    }
    Ok(())
}

fn stage_drafts(
    draft: RawFd,
    transaction: RawFd,
    draft_device: u64,
    root_device: u64,
    request: &PromotionRequest,
) -> Result<(), NativeError> {
    for change in &request.changes {
        let Some(expected) = &change.draft else {
            continue;
        };
        let segments = path_segments(&change.path)?;
        let (draft_parent, draft_name) = open_parent(draft, &segments, draft_device)?;
        let (stage_parent, stage_name) =
            journal_child_parent(transaction, JOURNAL_STAGE, &change.path, root_device)?;
        copy_file(
            draft_parent.as_raw_fd(),
            draft_name.to_str().expect("validated path"),
            draft_device,
            stage_parent.as_raw_fd(),
            &stage_name,
            expected,
        )?;
    }
    Ok(())
}

fn apply_changes(
    root: RawFd,
    transaction: RawFd,
    root_device: u64,
    request: &PromotionRequest,
) -> Result<(), NativeError> {
    for change in &request.changes {
        let segments = path_segments(&change.path)?;
        let (host_parent, host_name) = open_parent(root, &segments, root_device)?;
        if change.base.is_some() {
            let (backup_parent, backup_name) =
                journal_child_parent(transaction, JOURNAL_BACKUP, &change.path, root_device)?;
            rename_without_replace(
                host_parent.as_raw_fd(),
                host_name.to_str().expect("validated path"),
                backup_parent.as_raw_fd(),
                &backup_name,
            )?;
        }
        if change.draft.is_some() {
            let (stage_parent, stage_name) =
                journal_child_parent(transaction, JOURNAL_STAGE, &change.path, root_device)?;
            rename_without_replace(
                stage_parent.as_raw_fd(),
                &stage_name,
                host_parent.as_raw_fd(),
                host_name.to_str().expect("validated path"),
            )?;
        }
    }
    Ok(())
}

pub fn apply(
    root_fd: RawFd,
    draft_fd: RawFd,
    request: &PromotionRequest,
) -> Result<(), NativeError> {
    validate_promotion_request(request)?;
    let manifest = request.manifest();
    let (_, root_device) = ordinary_directory(root_fd, None)?;
    let (_, draft_device) = ordinary_directory(draft_fd, None)?;
    let journal = ensure_directory_at(root_fd, JOURNAL_DIRECTORY, root_device)?;
    recover_journals(root_fd, journal.as_raw_fd(), root_device)?;
    preflight(root_fd, draft_fd, &manifest)?;
    let transaction = create_directory_at(journal.as_raw_fd(), &request.promotion_id, root_device)?;
    write_new_file(
        transaction.as_raw_fd(),
        JOURNAL_REQUEST,
        &request_bytes(request)?,
    )?;
    if let Err(error) = stage_drafts(
        draft_fd,
        transaction.as_raw_fd(),
        draft_device,
        root_device,
        request,
    )
    .and_then(|_| apply_changes(root_fd, transaction.as_raw_fd(), root_device, request))
    {
        rollback_changes(root_fd, transaction.as_raw_fd(), root_device, request)?;
        return Err(error);
    }
    write_new_file(transaction.as_raw_fd(), JOURNAL_COMMITTED, b"committed\n")?;
    remove_journal_tree(journal.as_raw_fd(), &request.promotion_id, root_device)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::preflight::{hash_file, manifest_digest};
    use crate::protocol::{Change, ChangeKind, DigestEntry, PreflightRequest, PROTOCOL_VERSION};
    use std::fs::{self, File};

    fn digest_file(path: &std::path::Path) -> DigestEntry {
        hash_file(File::open(path).expect("fixture file")).expect("fixture digest")
    }

    fn promotion(changes: Vec<Change>, promotion_id: &str) -> PromotionRequest {
        let manifest = PreflightRequest {
            changes,
            manifest_digest: String::new(),
            protocol_version: PROTOCOL_VERSION,
            run_id: "00000000-0000-4000-8000-000000000001".to_owned(),
        };
        PromotionRequest {
            approval_digest:
                "sha256:0000000000000000000000000000000000000000000000000000000000000000".to_owned(),
            binding_fence: "1".to_owned(),
            changes: manifest.changes.clone(),
            manifest_digest: manifest_digest(&manifest).expect("manifest digest"),
            promotion_id: promotion_id.to_owned(),
            protocol_version: PROTOCOL_VERSION,
            run_id: manifest.run_id,
        }
    }

    #[test]
    fn applies_and_recovers_promotions() {
        let root = tempfile::tempdir().expect("host root");
        let draft = tempfile::tempdir().expect("draft root");
        fs::write(root.path().join("file.txt"), "base").expect("host fixture");
        fs::write(draft.path().join("file.txt"), "draft").expect("draft fixture");
        let request = promotion(
            vec![Change {
                base: Some(digest_file(&root.path().join("file.txt"))),
                draft: Some(digest_file(&draft.path().join("file.txt"))),
                kind: ChangeKind::Modified,
                path: "file.txt".to_owned(),
            }],
            "00000000-0000-4000-8000-000000000002",
        );
        let root_fd = File::open(root.path()).expect("host descriptor");
        let draft_fd = File::open(draft.path()).expect("draft descriptor");
        apply(root_fd.as_raw_fd(), draft_fd.as_raw_fd(), &request).expect("apply promotion");
        assert_eq!(
            fs::read_to_string(root.path().join("file.txt")).unwrap(),
            "draft"
        );

        fs::write(root.path().join("file.txt"), "base").expect("restore fixture");
        let (_, root_device) =
            ordinary_directory(root_fd.as_raw_fd(), None).expect("host directory");
        let (_, draft_device) =
            ordinary_directory(draft_fd.as_raw_fd(), None).expect("draft directory");
        let journal = ensure_directory_at(root_fd.as_raw_fd(), JOURNAL_DIRECTORY, root_device)
            .expect("journal directory");
        let transaction =
            create_directory_at(journal.as_raw_fd(), &request.promotion_id, root_device)
                .expect("transaction directory");
        write_new_file(
            transaction.as_raw_fd(),
            JOURNAL_REQUEST,
            &request_bytes(&request).unwrap(),
        )
        .expect("journal request");
        stage_drafts(
            draft_fd.as_raw_fd(),
            transaction.as_raw_fd(),
            draft_device,
            root_device,
            &request,
        )
        .expect("stage draft");
        apply_changes(
            root_fd.as_raw_fd(),
            transaction.as_raw_fd(),
            root_device,
            &request,
        )
        .expect("interrupted promotion");
        recover_journals(root_fd.as_raw_fd(), journal.as_raw_fd(), root_device).expect("recover");
        assert_eq!(
            fs::read_to_string(root.path().join("file.txt")).unwrap(),
            "base"
        );
    }

    #[test]
    fn applies_created_and_deleted_files_and_rejects_bad_digest() {
        let root = tempfile::tempdir().expect("host root");
        let draft = tempfile::tempdir().expect("draft root");
        fs::write(root.path().join("deleted.txt"), "remove").expect("host fixture");
        fs::write(draft.path().join("created.txt"), "add").expect("draft fixture");
        let request = promotion(
            vec![
                Change {
                    base: Some(digest_file(&root.path().join("deleted.txt"))),
                    draft: None,
                    kind: ChangeKind::Deleted,
                    path: "deleted.txt".to_owned(),
                },
                Change {
                    base: None,
                    draft: Some(digest_file(&draft.path().join("created.txt"))),
                    kind: ChangeKind::Created,
                    path: "created.txt".to_owned(),
                },
            ],
            "00000000-0000-4000-8000-000000000003",
        );
        let root_fd = File::open(root.path()).expect("host descriptor");
        let draft_fd = File::open(draft.path()).expect("draft descriptor");
        apply(root_fd.as_raw_fd(), draft_fd.as_raw_fd(), &request).expect("apply promotion");
        assert!(!root.path().join("deleted.txt").exists());
        assert_eq!(
            fs::read_to_string(root.path().join("created.txt")).unwrap(),
            "add"
        );

        let mut invalid = request;
        invalid.manifest_digest =
            "sha256:0000000000000000000000000000000000000000000000000000000000000000".to_owned();
        assert_eq!(
            apply(root_fd.as_raw_fd(), draft_fd.as_raw_fd(), &invalid)
                .unwrap_err()
                .code,
            "EXECUTOR_PROMOTION_MANIFEST_INVALID"
        );
    }
}
