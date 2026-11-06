//! Machine-owned state. Network/installer work never holds the preferences lock.
use crate::{
    catalog::UpdateResult,
    protocol::{Channel, PendingInstall, SeenRelease},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub format: u32,
    pub automatic: bool,
    pub channel: Channel,
    pub reminded_version: Option<String>,
    pub remind_after: Option<u64>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            format: 1,
            automatic: true,
            channel: Channel::Stable,
            reminded_version: None,
            remind_after: None,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Journal {
    pub format: u32,
    pub seen: BTreeMap<Channel, SeenRelease>,
    pub last_checked_at: Option<u64>,
    pub available_envelope: Option<String>,
    pub pending: Option<PendingInstall>,
    pub request_id: Option<String>,
    pub manual: bool,
    pub code: Option<String>,
    #[serde(default)]
    pub check_requested_at: Option<u64>,
    #[serde(default)]
    pub next_check_at: u64,
    #[serde(default)]
    pub next_install_attempt_at: u64,
    #[serde(default)]
    pub check_failures: u32,
    #[serde(default)]
    pub last_check_attempt_at: u64,
    #[serde(default)]
    pub check_code: Option<String>,
    #[serde(default)]
    pub install_failures: u32,
}

pub struct Store {
    root: PathBuf,
}
impl Store {
    /// The native host validates/owns this fixed directory before constructing a store.
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Only the native host supplies this receipt, after kernel creation proof.
    /// It never accepts receipt fields or a destination path from IPC callers.
    pub fn save_health(&self, value: &serde_json::Value) -> UpdateResult<()> {
        self.write("healthy.json", value)
    }

    /// The native host supplies only independently observed application owners
    /// and generations. All mutations hold the native admission lock.
    pub fn applications(&self) -> UpdateResult<serde_json::Value> {
        Ok(self.read("applications.json")?.unwrap_or_else(|| serde_json::json!([])))
    }
    pub fn save_applications(&self, value: &serde_json::Value) -> UpdateResult<()> {
        self.write("applications.json", value)
    }
    pub fn restart_observation(&self) -> UpdateResult<Option<serde_json::Value>> {
        self.read("restart-observation.json")
    }
    pub fn save_restart_observation(&self, value: &serde_json::Value) -> UpdateResult<()> {
        self.write("restart-observation.json", value)
    }

    pub(crate) fn save_superseded(
        &self,
        journal: &Journal,
        next: &str,
        now: u64,
    ) -> UpdateResult<()> {
        let prior = journal.pending.as_ref().ok_or("update.state_unavailable")?;
        for digest in [&prior.digest, next] {
            if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("update.invalid_manifest");
            }
        }
        let root = self.root.join("superseded");
        fs::create_dir_all(&root).map_err(|_| "update.state_unavailable")?;
        let entry = fs::symlink_metadata(&root).map_err(|_| "update.state_unavailable")?;
        if !entry.is_dir() || entry.file_type().is_symlink() {
            return Err("update.state_unavailable");
        }
        let archive = Store::new(root);
        let name = format!("{}--{next}.json", prior.digest);
        let transaction = serde_json::to_value(prior).map_err(|_| "update.state_unavailable")?;
        if let Some(existing) = archive.read::<serde_json::Value>(&name)? {
            return if existing["transaction"] == transaction && existing["supersededBy"] == next {
                Ok(())
            } else {
                Err("update.state_unavailable")
            };
        }
        archive.write(
            &name,
            &serde_json::json!({ "transaction":transaction, "supersededBy":next, "at":now,
                "failureCode":journal.code, "installFailures":journal.install_failures,
                "requestId":journal.request_id }),
        )
    }

    pub fn save_worker_reference(&self, digest: &str) -> UpdateResult<()> {
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("update.invalid_worker");
        }
        self.write(
            "worker.json",
            &serde_json::json!({ "format": 1, "digest": digest }),
        )
    }

    pub fn worker_reference(&self) -> UpdateResult<String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Reference {
            format: u32,
            digest: String,
        }
        let value: Reference = self.read("worker.json")?.ok_or("update.invalid_worker")?;
        if value.format != 1
            || value.digest.len() != 64
            || !value.digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("update.invalid_worker");
        }
        Ok(value.digest)
    }

    fn read<T: DeserializeOwned>(&self, name: &str) -> UpdateResult<Option<T>> {
        let path = self.root.join(name);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("update.state_unavailable"),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 1_000_000 {
            return Err("update.state_unavailable");
        }
        let file = File::open(&path).map_err(|_| "update.state_unavailable")?;
        let mut bytes = Vec::new();
        file.take(1_000_001)
            .read_to_end(&mut bytes)
            .map_err(|_| "update.state_unavailable")?;
        if bytes.len() > 1_000_000 {
            return Err("update.state_unavailable");
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "update.state_unavailable")
    }

    pub fn preferences(&self) -> UpdateResult<Preferences> {
        let value: Preferences = self.read("preferences.json")?.unwrap_or_default();
        if value.format != 1 {
            return Err("update.updater_required");
        }
        Ok(value)
    }

    pub fn journal(&self) -> UpdateResult<Journal> {
        let value: Journal = self.read("journal.json")?.unwrap_or_else(|| Journal {
            format: 1,
            ..Journal::default()
        });
        if value.format != 1 {
            return Err("update.updater_required");
        }
        Ok(value)
    }

    fn write<T: Serialize>(&self, name: &str, value: &T) -> UpdateResult<()> {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "update.state_unavailable")?
            .as_nanos();
        let temporary = self
            .root
            .join(format!(".{name}.{}.{nonce}.tmp", std::process::id()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "update.state_unavailable")?;
        let result = (|| {
            let bytes = serde_json::to_vec(value).map_err(|_| "update.state_unavailable")?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| "update.state_unavailable")?;
            drop(file);
            replace(&temporary, &self.root.join(name))?;
            #[cfg(unix)]
            File::open(&self.root)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| "update.state_unavailable")?;
            Ok(())
        })();
        if temporary.exists() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
    pub fn save_preferences(&self, value: &Preferences) -> UpdateResult<()> {
        self.write("preferences.json", value)
    }

    pub fn mutate_preferences(
        &self,
        mutation: impl FnOnce(&mut Preferences) -> UpdateResult<()>,
    ) -> UpdateResult<()> {
        let lock = self.lock("preferences.lock")?;
        let mut preferences = self.preferences()?;
        mutation(&mut preferences)?;
        self.save_preferences(&preferences)?;
        drop(lock);
        Ok(())
    }
    pub fn save_journal(&self, value: &Journal) -> UpdateResult<()> {
        self.write("journal.json", value)
    }

    /// Merge only the caller's changes under a short kernel lock. Downloads and
    /// package installation must never overwrite a request accepted meanwhile.
    pub fn mutate_journal(
        &self,
        mutation: impl FnOnce(&mut Journal) -> UpdateResult<()>,
    ) -> UpdateResult<Journal> {
        let _lock = self.lock("journal.lock")?;
        let mut journal = self.journal()?;
        mutation(&mut journal)?;
        self.save_journal(&journal)?;
        Ok(journal)
    }

    fn lock(&self, name: &str) -> UpdateResult<File> {
        let lock = self.open_lock(name)?;
        fs2::FileExt::lock_exclusive(&lock).map_err(|_| "update.state_unavailable")?;
        Ok(lock)
    }

    /// A live worker retains this kernel lease across downloads and installers.
    /// A crash releases the lease without removing its accepted transaction.
    pub fn worker(&self) -> UpdateResult<File> {
        self.try_lease("worker.lock")
    }
    pub fn broker(&self) -> UpdateResult<File> {
        self.try_lease("broker.lock")
    }
    /// Retained for the native worker process lifetime, including sleeps between ticks.
    pub fn runner(&self) -> UpdateResult<File> {
        self.try_lease("runner.lock")
    }
    fn try_lease(&self, name: &str) -> UpdateResult<File> {
        let lock = self.open_lock(name)?;
        fs2::FileExt::try_lock_exclusive(&lock).map_err(|error| {
            if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() {
                "update.busy"
            } else {
                "update.state_unavailable"
            }
        })?;
        Ok(lock)
    }

    fn open_lock(&self, name: &str) -> UpdateResult<File> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let lock = options
            .open(self.root.join(name))
            .map_err(|_| "update.state_unavailable")?;
        let metadata = lock.metadata().map_err(|_| "update.state_unavailable")?;
        if !metadata.is_file() || metadata.len() != 0 {
            return Err("update.state_unavailable");
        }
        Ok(lock)
    }
}

#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> UpdateResult<()> {
    fs::rename(from, to).map_err(|_| "update.state_unavailable")
}
#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> UpdateResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    if unsafe {
        MoveFileExW(
            wide(from).as_ptr(),
            wide(to).as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err("update.state_unavailable");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn process_leases_survive_between_ticks_and_release_without_deleting_state() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().to_path_buf());
        let broker = store.broker().unwrap();
        let runner = store.runner().unwrap();
        assert!(matches!(store.broker(), Err("update.busy")));
        assert!(matches!(store.runner(), Err("update.busy")));
        // The lifetime lease does not deadlock the per-tick coordinator lease.
        let tick = store.worker().unwrap();
        drop(tick);
        drop(runner);
        assert!(store.runner().is_ok());
        drop(broker);
        assert!(store.broker().is_ok());
        assert!(directory.path().join("runner.lock").is_file());
        assert!(directory.path().join("broker.lock").is_file());
    }
    #[test]
    fn progress_merges_a_request_accepted_while_an_installer_was_busy() {
        let directory = tempfile::tempdir().unwrap();
        let progress = Store::new(directory.path().to_path_buf());
        let control = Store::new(directory.path().to_path_buf());
        control
            .mutate_journal(|journal| {
                journal.manual = true;
                journal.request_id = Some("47f9e692-3756-4d0a-a626-77be8a955a93".into());
                Ok(())
            })
            .unwrap();
        progress
            .mutate_journal(|journal| {
                journal.last_checked_at = Some(100);
                Ok(())
            })
            .unwrap();
        let reopened = Store::new(directory.path().to_path_buf())
            .journal()
            .unwrap();
        assert!(reopened.manual);
        assert_eq!(
            reopened.request_id.as_deref(),
            Some("47f9e692-3756-4d0a-a626-77be8a955a93")
        );
        assert_eq!(reopened.last_checked_at, Some(100));
    }
    #[test]
    fn journal_progress_never_overwrites_a_concurrent_opt_out() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().to_path_buf());
        assert!(store.preferences().unwrap().automatic);
        let mut journal = store.journal().unwrap();
        let mut preferences = store.preferences().unwrap();
        preferences.automatic = false;
        store.save_preferences(&preferences).unwrap();
        journal.last_checked_at = Some(100);
        store.save_journal(&journal).unwrap();
        assert!(!store.preferences().unwrap().automatic);
        assert_eq!(store.journal().unwrap().last_checked_at, Some(100));
        fs::write(directory.path().join("preferences.json"), b"broken").unwrap();
        assert!(store.preferences().is_err());
    }
}
