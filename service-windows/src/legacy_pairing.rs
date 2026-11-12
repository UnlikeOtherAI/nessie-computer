//! A service-owned retry journal. It never stores the challenge or machine key.
use crate::{
    paths::pending_root,
    protocol::{valid_identifier, PairCommand},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const REFUSED: &str = "Nessie could not complete pairing. Check your connection and try again.";
const MISMATCH: &str = "Finish pairing from the Windows account that started it.";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Completed {
    pub executor_id: String,
    pub fingerprint: String,
}

pub(crate) struct LegacyPairing {
    // Never remove a lock inode; another process may already have opened it.
    _lock: File,
    pub staging: PathBuf,
    result: PathBuf,
}

fn load<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= 16 * 1024 => {}
        _ => return Err(REFUSED.into()),
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| REFUSED)?)
        .map(Some)
        .map_err(|_| REFUSED.into())
}

// Each record is published once, while its persistent kernel lock is held.
// A crash leaves either the complete record or an unpublished draft, never a
// half-written authoritative record. Retrying overwrites only that draft.
fn publish(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let draft = path.with_extension("draft");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&draft)
        .map_err(|_| REFUSED)?;
    file.write_all(&serde_json::to_vec(value).map_err(|_| REFUSED)?)
        .map_err(|_| REFUSED)?;
    file.sync_all().map_err(|_| REFUSED)?;
    drop(file);
    fs::rename(draft, path).map_err(|_| REFUSED.into())
}

impl LegacyPairing {
    pub fn open(
        root: &Path,
        command: &PairCommand,
        owner: Option<&str>,
        secure: impl Fn(&Path) -> Result<(), String>,
    ) -> Result<Self, String> {
        let owner = owner
            .filter(|sid| nessie_windows_common::is_sid_string(sid))
            .ok_or(MISMATCH)?;
        if !valid_identifier(&command.enrollment_id) {
            return Err(REFUSED.into());
        }
        let pending = pending_root(root);
        secure(&pending)?;
        let stem = pending.join(format!("{}.legacy", command.enrollment_id));
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(stem.with_extension("legacy-lock"))
            .map_err(|_| REFUSED)?;
        lock.try_lock()
            .map_err(|_| "Pairing is busy. Try again in a moment.")?;
        let request_path = stem.with_extension("legacy-request.json");
        let digest = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(
                    &command.api_base_url,
                    &command.enrollment_id,
                    &command.challenge,
                    &command.workspace_root,
                    owner,
                ))
                .map_err(|_| REFUSED)?
            )
        );
        let staging = pending.join(&command.enrollment_id);
        match load::<Request>(&request_path)? {
            Some(request) if request.digest == digest => {}
            Some(_) => return Err(MISMATCH.into()),
            None => {
                // No durable original owner/input proof: never adopt or erase
                // an older, unbound staging directory on somebody else's retry.
                if staging.exists()
                    && fs::read_dir(&staging)
                        .map_err(|_| REFUSED)?
                        .next()
                        .is_some()
                {
                    return Err(MISMATCH.into());
                }
                publish(&request_path, &Request { digest })?;
            }
        }
        Ok(Self {
            _lock: lock,
            staging,
            result: stem.with_extension("legacy-result.json"),
        })
    }

    pub fn completed(&self) -> Result<Option<Completed>, String> {
        load(&self.result)
    }

    pub fn record(&self, executor_id: String, fingerprint: String) -> Result<Completed, String> {
        let completed = Completed {
            executor_id,
            fingerprint,
        };
        publish(&self.result, &completed)?;
        Ok(completed)
    }
}

#[cfg(test)]
#[path = "legacy_pairing_tests.rs"]
mod tests;
