//! An inventory helper's death must not reopen launches while its controller lives.
use crate::{managed_runtime::Record, managed_runtime_context, protocol::NativeError};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const NAME: &str = "inventory-transition.json";
fn refused() -> NativeError {
    NativeError::new("EXECUTOR_MANAGED_TRANSITION_UNRESOLVED")
}

fn absent_generation(pid: i32, started: &str) -> Result<bool, NativeError> {
    #[cfg(target_os = "macos")]
    {
        match crate::macos_processes::information(pid)? {
            Some(process) => return Ok(process.started_at != started),
            None => return Ok(true),
        }
    }
    #[cfg(target_os = "linux")]
    {
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => {
            let end = stat.rfind(')').ok_or_else(refused)?;
            let birth = stat[end + 1..]
                .split_whitespace()
                .nth(19)
                .ok_or_else(refused)?;
            if birth.is_empty() || !birth.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(refused());
            }
            Ok(birth != started)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err(refused()),
    }
    }
}

/// Called with both kernel admission locks held. A normal supervisor removes
/// its creation record only after ECHILD; parent absence alone proves no tree.
pub fn refuse_unresolved(root: &Path) -> Result<(), NativeError> {
    let draft = root.join("inventory-transition.draft");
    match fs::symlink_metadata(&draft) {
        Ok(entry) => {
            let canonical = fs::symlink_metadata(root.join(NAME)).ok();
            let published_link = entry.nlink() == 2
                && canonical.as_ref().is_some_and(|other| {
                    other.is_file() && other.dev() == entry.dev() && other.ino() == entry.ino()
                });
            if !entry.is_file()
                || entry.uid() != unsafe { libc::getuid() }
                || entry.mode() & 0o077 != 0
                || entry.nlink() != 1 && !published_link
                || entry.len() > 8192
            {
                return Err(refused());
            }
            // The callback is published only after atomic canonical creation;
            // acquiring both locks proves this earlier draft writer is gone.
            fs::remove_file(draft).map_err(|_| refused())?;
            File::open(root)
                .map_err(|_| refused())?
                .sync_all()
                .map_err(|_| refused())?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(refused()),
    }
    let path = root.join(NAME);
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(refused()),
    };
    let metadata = file.metadata().map_err(|_| refused())?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::getuid() }
        || metadata.nlink() != 1
        || metadata.mode() & 0o077 != 0
        || metadata.len() > 8192
    {
        return Err(refused());
    }
    let record: Record = serde_json::from_reader(file).map_err(|_| refused())?;
    if !managed_runtime_context::valid_boot_id(&record.boot_id)
        || record.protocol_version != 1
        || record.guard_version != crate::managed_release::GUARD_VERSION
        || record.supervisor_pid <= 0
        || record.child_pid <= 0
        || record.supervisor_started_at.is_empty()
        || record.child_started_at.is_empty()
        || !record
            .supervisor_started_at
            .bytes()
            .all(|byte| byte.is_ascii_digit())
        || !record
            .child_started_at
            .bytes()
            .all(|byte| byte.is_ascii_digit())
    {
        return Err(refused());
    }
    let current_boot = managed_runtime_context::boot_id()?;
    if record.boot_id == current_boot {
        let journal = root.join("managed-runtimes").join(format!(
            "{}_{}-{}.json",
            &record.boot_id[..8],
            record.supervisor_pid,
            record.supervisor_started_at
        ));
        if !absent_generation(record.child_pid, &record.child_started_at)?
            || !absent_generation(record.supervisor_pid, &record.supervisor_started_at)?
            || journal.try_exists().map_err(|_| refused())?
        {
            return Err(refused());
        }
    }
    fs::remove_file(path).map_err(|_| refused())?;
    File::open(root)
        .map_err(|_| refused())?
        .sync_all()
        .map_err(|_| refused())
}

pub struct Transition {
    path: PathBuf,
}
impl Transition {
    pub fn publish(root: &Path, controller: &Record) -> Result<Self, NativeError> {
        let path = root.join(NAME);
        let draft = root.join("inventory-transition.draft");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&draft)
            .map_err(|_| refused())?;
        file.write_all(&serde_json::to_vec(controller).map_err(|_| refused())?)
            .map_err(|_| refused())?;
        file.sync_all().map_err(|_| refused())?;
        fs::hard_link(&draft, &path).map_err(|_| refused())?;
        fs::remove_file(draft).map_err(|_| refused())?;
        File::open(root)
            .map_err(|_| refused())?
            .sync_all()
            .map_err(|_| refused())?;
        Ok(Self { path })
    }
    pub fn release(self) -> Result<(), NativeError> {
        fs::remove_file(&self.path).map_err(|_| refused())?;
        File::open(self.path.parent().ok_or_else(refused)?)
            .map_err(|_| refused())?
            .sync_all()
            .map_err(|_| refused())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record() -> Record {
        Record {
            protocol_version: 1,
            guard_version: crate::managed_release::GUARD_VERSION,
            boot_id: managed_runtime_context::boot_id().unwrap(),
            supervisor_pid: i32::MAX,
            supervisor_started_at: "1".to_owned(),
            child_pid: unsafe { libc::getpid() },
            child_started_at: managed_runtime_context::birth(unsafe { libc::getpid() }).unwrap(),
            release_digest: "a".repeat(64),
        }
    }
    #[test]
    fn unpublished_and_linked_publication_crashes_recover_without_clearing_live_controller() {
        let root = tempfile::tempdir().unwrap();
        let draft = root.path().join("inventory-transition.draft");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&draft)
            .unwrap();
        drop(file);
        refuse_unresolved(root.path()).unwrap();
        assert!(!draft.exists());
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&draft)
            .unwrap();
        file.write_all(&serde_json::to_vec(&record()).unwrap())
            .unwrap();
        file.sync_all().unwrap();
        fs::hard_link(&draft, root.path().join(NAME)).unwrap();
        assert!(refuse_unresolved(root.path()).is_err());
        assert!(!draft.exists());
        assert!(root.path().join(NAME).exists());
    }
    #[test]
    fn helper_loss_does_not_clear_live_controller_and_normal_release_does() {
        let root = tempfile::tempdir().unwrap();
        let transition = Transition::publish(root.path(), &record()).unwrap();
        assert!(refuse_unresolved(root.path()).is_err());
        transition.release().unwrap();
        refuse_unresolved(root.path()).unwrap();
    }
    #[test]
    fn positive_controller_tree_clearance_recovers_but_retained_journal_keeps_fence() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("managed-runtimes")).unwrap();
        let mut record = record();
        record.child_pid = i32::MAX - 1;
        let journal = root.path().join("managed-runtimes").join(format!(
            "{}_{}-{}.json",
            &record.boot_id[..8],
            record.supervisor_pid,
            record.supervisor_started_at
        ));
        fs::write(&journal, b"retained uncertain tree").unwrap();
        let _transition = Transition::publish(root.path(), &record).unwrap();
        assert!(refuse_unresolved(root.path()).is_err());
        fs::remove_file(journal).unwrap();
        refuse_unresolved(root.path()).unwrap();
        assert!(!root.path().join(NAME).exists());
    }
}
