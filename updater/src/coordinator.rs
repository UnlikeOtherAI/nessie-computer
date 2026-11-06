//! One transaction owner for all installed platforms. Only native hosts implement installation.
use crate::{
    catalog::{compare_versions, release_key, verify_manifest, UpdateResult},
    network::{self, Network},
    protocol::{Manifest, PendingInstall, Phase, SeenRelease, Target, VerifiedManifest},
    storage::{Journal, Store},
};
use std::{
    cmp::Ordering,
    fs,
    path::{Path, PathBuf},
};

pub struct Installed {
    pub version: String,
    pub source_commit: String,
}

/// Each host authenticates its fixed installed context, coordinates every local
/// launch consumer, and holds the existing native admission barrier while replacing it.
pub trait Installer {
    fn target(&self) -> UpdateResult<Target>;
    fn installed(&self) -> UpdateResult<Installed>;
    fn verify_publishers(&self, manifest: &Manifest, directory: &Path) -> UpdateResult<()>;
    /// False means active work or unresolved native clearance; do not stop or cancel it.
    fn replace_when_clear(&self, manifest: &Manifest, directory: &Path) -> UpdateResult<bool>;
    /// A newly running verified installation, not merely newer files on disk.
    fn confirm_restarted(&self, manifest: &Manifest) -> UpdateResult<bool>;
}

pub struct Coordinator<'a> {
    pub store: &'a Store,
    pub network: &'a Network,
    pub installer: &'a dyn Installer,
}

impl Coordinator<'_> {
    fn accepted(&self, pending: &PendingInstall) -> UpdateResult<VerifiedManifest> {
        // A root-owned accepted transaction survives catalogue expiry during reboot.
        // Verify its original signed validity interval at acceptance, and retain its replay floor.
        let verified = verify_manifest(
            &pending.envelope,
            &release_key()?,
            pending.started_at as i64,
            pending.channel,
            None,
        )?;
        if verified.digest != pending.digest {
            return Err("update.invalid_manifest");
        }
        Ok(verified)
    }

    pub fn check(&self, now: u64) -> UpdateResult<()> {
        let preferences = self.store.preferences()?;
        let journal = self.store.journal()?;
        let envelope = self.network.catalog(preferences.channel)?;
        let verified = verify_manifest(
            &envelope,
            &release_key()?,
            now as i64,
            preferences.channel,
            journal.seen.get(&preferences.channel),
        )?;
        let installed = self.installer.installed()?;
        let ordering = compare_versions(&verified.manifest.version, &installed.version)?;
        if ordering == Ordering::Equal && verified.manifest.source_commit != installed.source_commit
        {
            return Err("update.version_conflict");
        }
        if self.store.preferences()?.channel != preferences.channel {
            return Err("update.channel_changed");
        }
        self.store
            .mutate_journal(|current| {
                // Another check may have completed while this download was in flight.
                verify_manifest(
                    &envelope,
                    &release_key()?,
                    now as i64,
                    preferences.channel,
                    current.seen.get(&preferences.channel),
                )?;
                current.seen.insert(
                    preferences.channel,
                    SeenRelease {
                        sequence: verified.manifest.sequence,
                        digest: verified.digest.clone(),
                    },
                );
                current.last_checked_at = Some(now);
                if current.check_requested_at == journal.check_requested_at {
                    current.check_requested_at = None;
                }
                current.available_envelope = if ordering == Ordering::Greater {
                    Some(envelope)
                } else {
                    None
                };
                current.code = None;
                Ok(())
            })
            .map(|_| ())
    }

    /// Persist manual intent before returning the native ACK. Repeated delivery is idempotent.
    pub fn request_install(&self, request_id: &str) -> UpdateResult<()> {
        if request_id.len() != 36
            || !request_id.bytes().enumerate().all(|(index, byte)| {
                if [8, 13, 18, 23].contains(&index) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            })
        {
            return Err("update.invalid_request");
        }
        self.store
            .mutate_journal(|journal| {
                if journal.request_id.as_deref() == Some(request_id) {
                    return Ok(());
                }
                if journal.pending.is_some() && journal.manual {
                    return Err("update.busy");
                }
                journal.manual = true;
                journal.request_id = Some(request_id.to_owned());
                Ok(())
            })
            .map(|_| ())
    }

    fn stage_directory(&self, digest: &str) -> UpdateResult<PathBuf> {
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("update.invalid_manifest");
        }
        let root = self.store.root().join("staged");
        for directory in [&root, &root.join(digest)] {
            match fs::symlink_metadata(directory) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => return Err("update.state_unavailable"),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir(directory).map_err(|_| "update.state_unavailable")?;
                }
                Err(_) => return Err("update.state_unavailable"),
            }
        }
        Ok(root.join(digest))
    }

    pub fn advance(&self, now: u64) -> UpdateResult<()> {
        let preferences = self.store.preferences()?;
        let journal = self.store.journal()?;
        if journal.pending.is_none() {
            if !preferences.automatic && !journal.manual {
                return Ok(());
            }
            let Some(envelope) = journal.available_envelope.as_ref() else {
                return Ok(());
            };
            let verified = verify_manifest(
                envelope,
                &release_key()?,
                now as i64,
                preferences.channel,
                journal.seen.get(&preferences.channel),
            )?;
            if compare_versions(
                &verified.manifest.version,
                &self.installer.installed()?.version,
            )? != Ordering::Greater
            {
                return Ok(());
            }
            self.store.mutate_journal(|current| {
                if current.pending.is_none() {
                    current.pending = Some(PendingInstall {
                        channel: preferences.channel,
                        envelope: envelope.clone(),
                        digest: verified.digest,
                        phase: Phase::Downloading,
                        started_at: now,
                    });
                }
                Ok(())
            })?;
        }
        self.resume(now)
    }

    pub fn resume(&self, now: u64) -> UpdateResult<()> {
        let mut journal = self.store.journal()?;
        let Some(pending) = journal.pending.clone() else {
            return Ok(());
        };
        let verified = self.accepted(&pending)?;
        let target = self.installer.target()?;
        let assets = verified
            .manifest
            .targets
            .get(&target)
            .ok_or("update.unsupported_platform")?;
        let directory = self.stage_directory(&pending.digest)?;
        match pending.phase {
            Phase::Downloading => {
                for asset in assets {
                    self.network.download(asset, &directory)?;
                }
                self.installer
                    .verify_publishers(&verified.manifest, &directory)?;
                self.phase(&mut journal, Phase::Waiting)?;
            }
            Phase::Waiting | Phase::Installing => {
                // Re-read policy after the download; disabling automatic updates wins.
                if !journal.manual && !self.store.preferences()?.automatic {
                    return Ok(());
                }
                for asset in assets {
                    network::verify_file(&directory.join(&asset.name), asset)?;
                }
                self.installer
                    .verify_publishers(&verified.manifest, &directory)?;
                self.phase(&mut journal, Phase::Installing)?;
                if self
                    .installer
                    .replace_when_clear(&verified.manifest, &directory)?
                {
                    self.phase(&mut journal, Phase::Restarting)?;
                } else {
                    self.phase(&mut journal, Phase::Waiting)?;
                }
            }
            Phase::Restarting => {
                let installed = self.installer.installed()?;
                if installed.version != verified.manifest.version
                    || installed.source_commit != verified.manifest.source_commit
                    || !self.installer.confirm_restarted(&verified.manifest)?
                {
                    return Ok(());
                }
                // Preserve the complete accepted transaction before clearing only its completed pointer.
                let completed = self.store.root().join("completed");
                fs::create_dir_all(&completed).map_err(|_| "update.state_unavailable")?;
                let record = completed.join(format!("{}.json", pending.digest));
                if !record.exists() {
                    let file = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&record)
                        .map_err(|_| "update.state_unavailable")?;
                    serde_json::to_writer(
                        &file,
                        &serde_json::json!({ "transaction": pending, "completedAt": now }),
                    )
                    .map_err(|_| "update.state_unavailable")?;
                    file.sync_all().map_err(|_| "update.state_unavailable")?;
                }
                self.store.mutate_journal(|current| {
                    if current.pending.as_ref().map(|value| &value.digest) != Some(&pending.digest)
                    {
                        return Err("update.state_unavailable");
                    }
                    current.pending = None;
                    if current.request_id == journal.request_id {
                        current.manual = false;
                    }
                    current.code = None;
                    Ok(())
                })?;
            }
            _ => return Err("update.state_unavailable"),
        }
        Ok(())
    }

    fn phase(&self, journal: &mut Journal, phase: Phase) -> UpdateResult<()> {
        let digest = journal
            .pending
            .as_ref()
            .ok_or("update.state_unavailable")?
            .digest
            .clone();
        *journal = self.store.mutate_journal(|current| {
            let pending = current.pending.as_mut().ok_or("update.state_unavailable")?;
            if pending.digest != digest {
                return Err("update.state_unavailable");
            }
            pending.phase = phase;
            current.code = None;
            Ok(())
        })?;
        Ok(())
    }
}
