//! Transaction tests use a compile-time-only test key; installed builds always use the vendor root.
use super::*;
use crate::protocol::{Asset, Channel};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{pkcs8::EncodePublicKey, Signer, SigningKey};
use sha2::{Digest, Sha256};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
};

struct Host {
    installed: RefCell<Installed>,
    busy: Cell<bool>,
    healthy: Cell<bool>,
    installs: Cell<usize>,
    root: PathBuf,
}
impl Installer for Host {
    fn target(&self) -> UpdateResult<Target> {
        Ok(Target::WindowsX64Msi)
    }
    fn installed(&self) -> UpdateResult<Installed> {
        let value = self.installed.borrow();
        Ok(Installed {
            version: value.version.clone(),
            source_commit: value.source_commit.clone(),
        })
    }
    fn set_draining(&self, _: bool, _: bool) -> UpdateResult<()> {
        Ok(())
    }
    fn verify_publishers(&self, _: &Manifest, _: &Path) -> UpdateResult<()> {
        Ok(())
    }
    fn replace_when_clear(
        &self,
        manifest: &Manifest,
        _: &Path,
        begin: &mut dyn FnMut() -> UpdateResult<()>,
    ) -> UpdateResult<bool> {
        if self.busy.get() {
            return Ok(false);
        }
        begin()?;
        assert_eq!(
            Store::new(self.root.clone())
                .journal()?
                .pending
                .unwrap()
                .phase,
            Phase::Installing,
            "the durable phase precedes every installer side effect"
        );
        self.installs.set(self.installs.get() + 1);
        *self.installed.borrow_mut() = Installed {
            version: manifest.version.clone(),
            source_commit: manifest.source_commit.clone(),
        };
        Ok(true)
    }
    fn confirm_restarted(&self, _: &Manifest) -> UpdateResult<bool> {
        Ok(self.healthy.get())
    }
}

fn fixture() -> (
    tempfile::TempDir,
    Store,
    Host,
    String,
    Manifest,
    String,
    u64,
) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().to_path_buf();
    let key = SigningKey::from_bytes(&[42; 32]);
    let public = key
        .verifying_key()
        .to_public_key_pem(Default::default())
        .unwrap();
    let manifest = Manifest { format: 1, channel: Channel::Stable, sequence: 1, version: "1.0.1".into(),
        source_commit: "b".repeat(40), published_at: "2026-11-05T00:00:00.000Z".into(),
        expires_at: "2026-11-07T00:00:00.000Z".into(), minimum_updater_protocol: 1,
        targets: BTreeMap::from([(Target::WindowsX64Msi, vec![Asset { name: "executor.msi".into(), size: 4,
            sha256: format!("{:x}", Sha256::digest(b"good")),
            url: "https://github.com/UnlikeOtherAI/nessie-executor/releases/download/executor-v1.0.1/executor.msi".into() }])]) };
    let payload = serde_json::to_vec(&manifest).unwrap();
    let envelope = serde_json::json!({"payload":STANDARD.encode(&payload),
        "signature":STANDARD.encode(key.sign(&payload).to_bytes())})
    .to_string();
    let now = chrono::DateTime::parse_from_rfc3339("2026-11-06T00:00:00.000Z")
        .unwrap()
        .timestamp_millis() as u64;
    let store = Store::new(root.clone());
    store
        .mutate_journal(|journal| {
            journal.available_envelope = Some(envelope.clone());
            Ok(())
        })
        .unwrap();
    let verified = verify_manifest(&envelope, &public, now as i64, Channel::Stable, None).unwrap();
    let stage = root.join("staged").join(&verified.digest);
    fs::create_dir_all(&stage).unwrap();
    fs::write(stage.join("executor.msi"), b"good").unwrap();
    let host = Host {
        installed: RefCell::new(Installed {
            version: "1.0.0".into(),
            source_commit: "a".repeat(40),
        }),
        busy: Cell::new(true),
        healthy: Cell::new(false),
        installs: Cell::new(0),
        root,
    };
    (
        directory,
        store,
        host,
        public,
        manifest,
        verified.digest,
        now,
    )
}

#[test]
fn accepted_update_survives_expiry_waits_for_work_and_requires_a_new_healthy_process() {
    let (_directory, store, host, key, _manifest, digest, now) = fixture();
    let network = Network::default();
    let coordinator = Coordinator {
        store: &store,
        network: &network,
        installer: &host,
        test_key: key,
    };
    coordinator.advance(now).unwrap();
    assert_eq!(
        store.journal().unwrap().pending.unwrap().phase,
        Phase::Waiting
    );
    let expired = now + 7 * 86_400_000;
    coordinator.resume(expired).unwrap();
    assert_eq!(host.installs.get(), 0);
    assert_eq!(
        store.journal().unwrap().pending.unwrap().phase,
        Phase::Waiting
    );
    host.busy.set(false);
    coordinator.resume(expired).unwrap();
    assert_eq!(host.installs.get(), 1);
    assert_eq!(
        store.journal().unwrap().pending.unwrap().phase,
        Phase::Restarting
    );
    coordinator.resume(expired).unwrap();
    assert!(
        store.journal().unwrap().pending.is_some(),
        "newer files alone do not complete the transaction"
    );
    host.healthy.set(true);
    coordinator.resume(expired).unwrap();
    assert!(store.journal().unwrap().pending.is_none());
    assert!(store
        .root()
        .join("completed")
        .join(format!("{digest}.json"))
        .is_file());
}

#[test]
fn opting_out_after_staging_restores_a_notification_and_a_manual_request_resumes_the_same_transaction(
) {
    let (_directory, store, host, key, _manifest, digest, now) = fixture();
    let network = Network::default();
    let coordinator = Coordinator {
        store: &store,
        network: &network,
        installer: &host,
        test_key: key,
    };
    coordinator.advance(now).unwrap();
    store
        .mutate_preferences(|preferences| {
            preferences.automatic = false;
            Ok(())
        })
        .unwrap();
    let status = coordinator.status(now).unwrap();
    assert_eq!(status.phase, Phase::Available);
    assert!(!status.draining);
    assert!(status.notify);
    host.busy.set(false);
    coordinator.resume(now).unwrap();
    assert_eq!(host.installs.get(), 0);
    coordinator
        .request_install("11111111-1111-4111-8111-111111111111")
        .unwrap();
    coordinator.resume(now).unwrap();
    assert_eq!(host.installs.get(), 1);
    assert_eq!(store.journal().unwrap().pending.unwrap().digest, digest);
    assert!(!store.preferences().unwrap().automatic);
}

#[test]
fn a_damaged_staged_file_returns_to_download_without_discarding_its_accepted_transaction() {
    let (_directory, store, host, key, _manifest, digest, now) = fixture();
    let network = Network::default();
    let coordinator = Coordinator {
        store: &store,
        network: &network,
        installer: &host,
        test_key: key,
    };
    coordinator.advance(now).unwrap();
    let path = store
        .root()
        .join("staged")
        .join(&digest)
        .join("executor.msi");
    fs::write(&path, b"evil").unwrap();
    assert_eq!(coordinator.resume(now), Err("update.invalid_asset"));
    let journal = store.journal().unwrap();
    assert_eq!(journal.pending.as_ref().unwrap().digest, digest);
    assert_eq!(journal.pending.unwrap().phase, Phase::Downloading);
    fs::write(path, b"good").unwrap();
    coordinator.resume(now).unwrap();
    assert_eq!(
        store.journal().unwrap().pending.unwrap().phase,
        Phase::Waiting
    );
}

#[test]
fn a_new_signed_release_can_recover_every_phase_and_retains_its_predecessor() {
    for phase in [
        Phase::Downloading,
        Phase::Waiting,
        Phase::Installing,
        Phase::Restarting,
    ] {
        let (_directory, store, host, key, mut manifest, prior_digest, now) = fixture();
        let network = Network::default();
        let coordinator = Coordinator {
            store: &store,
            network: &network,
            installer: &host,
            test_key: key.clone(),
        };
        coordinator.advance(now).unwrap();
        store
            .mutate_journal(|journal| {
                journal.pending.as_mut().unwrap().phase = phase;
                journal.code = Some("update.installer_failed".into());
                Ok(())
            })
            .unwrap();
        manifest.version = "1.0.2".into();
        manifest.sequence = 2;
        manifest.source_commit = "c".repeat(40);
        manifest.targets.get_mut(&Target::WindowsX64Msi).unwrap()[0].url =
        "https://github.com/UnlikeOtherAI/nessie-executor/releases/download/executor-v1.0.2/executor.msi".into();
        let signer = SigningKey::from_bytes(&[42; 32]);
        let payload = serde_json::to_vec(&manifest).unwrap();
        let envelope = serde_json::json!({"payload":STANDARD.encode(&payload),
        "signature":STANDARD.encode(signer.sign(&payload).to_bytes())})
        .to_string();
        let next = verify_manifest(&envelope, &key, now as i64, Channel::Stable, None).unwrap();
        let stage = store.root().join("staged").join(&next.digest);
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join("executor.msi"), b"good").unwrap();
        store
            .mutate_journal(|journal| {
                journal.available_envelope = Some(envelope);
                Ok(())
            })
            .unwrap();
        coordinator.advance(now).unwrap();
        assert_eq!(
            store.journal().unwrap().pending.unwrap().digest,
            next.digest
        );
        assert!(store
            .root()
            .join("superseded")
            .join(format!("{prior_digest}--{}.json", next.digest))
            .is_file());
        assert!(store
            .root()
            .join("staged")
            .join(prior_digest)
            .join("executor.msi")
            .is_file());
        assert_eq!(host.installs.get(), 0);
    }
}

#[test]
fn an_expired_catalog_does_not_hide_the_version_or_prevent_local_opt_out() {
    let (_directory, store, host, key, _manifest, _digest, now) = fixture();
    let network = Network::default();
    let coordinator = Coordinator {
        store: &store,
        network: &network,
        installer: &host,
        test_key: key,
    };
    let expired = now + 7 * 86_400_000;
    let status = coordinator
        .control(
            crate::protocol::Request::Automatic { enabled: false },
            expired,
        )
        .unwrap();
    assert_eq!(status.installed_version, "1.0.0");
    assert_eq!(status.phase, Phase::Failed);
    assert!(status.can_install);
    assert!(!status.automatic);
    assert!(!status.notify);
    assert!(status.available_version.is_none());
    assert!(!store.preferences().unwrap().automatic);
}

#[test]
fn channel_selection_is_local_explicit_and_cannot_retarget_an_accepted_install() {
    let (_directory, store, host, key, _manifest, _digest, now) = fixture();
    let network = Network::default();
    let coordinator = Coordinator {
        store: &store,
        network: &network,
        installer: &host,
        test_key: key,
    };
    let preview = coordinator
        .control(
            crate::protocol::Request::Channel {
                channel: Channel::Preview,
            },
            now,
        )
        .unwrap();
    assert_eq!(preview.channel, Channel::Preview);
    assert_eq!(preview.phase, Phase::Checking);
    assert!(store.journal().unwrap().available_envelope.is_none());
    coordinator
        .control(
            crate::protocol::Request::Channel {
                channel: Channel::Stable,
            },
            now,
        )
        .unwrap();
    let (_other, initial, _, _, _, _, _) = fixture();
    store
        .mutate_journal(|journal| {
            journal.available_envelope = initial.journal()?.available_envelope;
            Ok(())
        })
        .unwrap();
    coordinator.advance(now).unwrap();
    assert_eq!(
        coordinator
            .control(
                crate::protocol::Request::Channel {
                    channel: Channel::Preview
                },
                now
            )
            .unwrap_err(),
        "update.installation_in_progress"
    );
    assert_eq!(store.preferences().unwrap().channel, Channel::Stable);
}

#[test]
fn a_failed_transaction_whose_release_was_installed_by_hand_stops_failing_and_is_confirmed() {
    let (_directory, store, host, key, manifest, _digest, now) = fixture();
    let network = Network::default();
    let coordinator = Coordinator { store: &store, network: &network, installer: &host, test_key: key };
    coordinator.advance(now).unwrap();
    // The worker's install attempt failed, as service.rs records it.
    store.mutate_journal(|journal| {
        journal.pending.as_mut().unwrap().phase = Phase::Installing;
        journal.code = Some("update.installer_failed".into());
        Ok(())
    }).unwrap();
    assert_eq!(coordinator.status(now).unwrap().phase, Phase::Failed);
    // The person then installs the same signed release.
    *host.installed.borrow_mut() = Installed { version: manifest.version.clone(), source_commit: manifest.source_commit.clone() };
    coordinator.resume(now).unwrap();
    assert_eq!(host.installs.get(), 0, "nothing is installed again");
    let journal = store.journal().unwrap();
    assert_eq!(journal.code, None);
    assert_eq!(journal.pending.unwrap().phase, Phase::Restarting);
    assert_ne!(coordinator.status(now).unwrap().phase, Phase::Failed);
    // The restart confirmation then completes it, as for an install of its own.
    host.healthy.set(true);
    coordinator.resume(now).unwrap();
    assert!(store.journal().unwrap().pending.is_none());
}

#[test]
fn a_different_build_of_the_same_version_is_not_the_target() {
    let (_directory, store, host, key, manifest, _digest, now) = fixture();
    let network = Network::default();
    let coordinator = Coordinator { store: &store, network: &network, installer: &host, test_key: key };
    coordinator.advance(now).unwrap();
    store.mutate_journal(|journal| {
        journal.code = Some("update.installer_failed".into());
        Ok(())
    }).unwrap();
    *host.installed.borrow_mut() = Installed { version: manifest.version.clone(), source_commit: "c".repeat(40) };
    host.busy.set(false);
    coordinator.resume(now).unwrap();
    assert_eq!(host.installs.get(), 1, "the signed release is installed, not assumed");
}

#[test]
fn a_failure_with_no_transaction_clears_once_its_release_is_installed() {
    let (_directory, store, host, key, manifest, _digest, now) = fixture();
    let network = Network::default();
    let coordinator = Coordinator { store: &store, network: &network, installer: &host, test_key: key };
    store.mutate_preferences(|preferences| {
        preferences.automatic = false;
        Ok(())
    }).unwrap();
    store.mutate_journal(|journal| {
        journal.code = Some("update.channel_changed".into());
        Ok(())
    }).unwrap();
    coordinator.advance(now).unwrap();
    assert_eq!(coordinator.status(now).unwrap().phase, Phase::Failed, "the release is not installed yet");
    *host.installed.borrow_mut() = Installed { version: manifest.version.clone(), source_commit: manifest.source_commit.clone() };
    coordinator.advance(now).unwrap();
    assert_eq!(store.journal().unwrap().code, None);
    assert_ne!(coordinator.status(now).unwrap().phase, Phase::Failed);
}
