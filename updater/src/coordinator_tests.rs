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
    draining: Cell<Option<bool>>,
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
    fn set_draining(&self, draining: bool, _: bool) -> UpdateResult<()> {
        self.draining.set(Some(draining));
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
        draining: Cell::new(None),
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

/// Never reach the network: these ticks exercise installation and admission only.
fn offline(store: &Store) {
    store
        .mutate_journal(|journal| {
            journal.next_check_at = u64::MAX;
            journal.last_checked_at = Some(1);
            Ok(())
        })
        .unwrap();
}

#[test]
fn a_waiting_drain_ends_by_itself_then_retries_and_never_installs_between_attempts() {
    let (_directory, store, host, key, _manifest, digest, now) = fixture();
    let network = Network::default();
    let coordinator = Coordinator { store: &store, network: &network, installer: &host, test_key: key };
    offline(&store);
    coordinator.advance(now).unwrap();
    coordinator.tick(now).unwrap();
    assert_eq!(host.draining.get(), Some(true), "waiting holds new work back");
    let reopened = now + crate::drain::WINDOW;
    coordinator.tick(reopened).unwrap();
    assert_eq!(host.draining.get(), Some(false), "a drain that never clears ends");
    let status = coordinator.status(reopened).unwrap();
    assert!(!status.draining);
    assert_eq!(status.phase, Phase::Waiting);
    assert_eq!(store.journal().unwrap().pending.unwrap().digest, digest);
    // Teams may start between attempts, so the machine is not replaced then.
    host.busy.set(false);
    coordinator.resume(reopened + 1).unwrap();
    assert_eq!(host.installs.get(), 0);
    let retry = now + crate::drain::WINDOW + crate::drain::PAUSE;
    coordinator.tick(retry).unwrap();
    assert_eq!(host.installs.get(), 1);
    assert_eq!(store.journal().unwrap().pending.unwrap().phase, Phase::Restarting);
    assert_eq!(host.draining.get(), Some(true), "replacement keeps the fence");
}

#[test]
fn a_newer_app_runtime_retires_the_stuck_transaction_and_ends_its_drain() {
    // The live Mac on 8 November: an old factory, an accepted older stage
    // waiting for clearance that never comes, and admissions held.
    let (_directory, store, host, key, _manifest, digest, now) = fixture();
    let network = Network::default();
    let coordinator = Coordinator { store: &store, network: &network, installer: &host, test_key: key };
    offline(&store);
    coordinator.advance(now).unwrap();
    coordinator.tick(now).unwrap();
    assert_eq!(host.draining.get(), Some(true));
    let (phase, version) = coordinator.accepted_pending().unwrap().unwrap();
    assert_eq!(
        crate::recovery::application_plan("1.0.0", "1.0.2", Some((phase, &version)), false, true).unwrap(),
        crate::recovery::ApplicationPlan::Install { persistent: true }
    );
    // The approved helper installs the app's own runtime (native side).
    *host.installed.borrow_mut() = Installed { version: "1.0.2".into(), source_commit: "c".repeat(40) };
    assert!(coordinator.retire_obsolete(now + 1).unwrap());
    assert!(store.journal().unwrap().pending.is_none());
    // An older worker still finishing its tick refuses the downgrade afterwards.
    store.mutate_journal(|journal| { journal.code = Some("update.downgrade_refused".into()); Ok(()) }).unwrap();
    assert!(store.root().join("retired").join(format!("{digest}.json")).is_file());
    assert!(store.root().join("staged").join(&digest).join("executor.msi").is_file(), "bytes are kept");
    coordinator.tick(now + 2_000).unwrap();
    assert_eq!(host.draining.get(), Some(false), "the drain ends with its transaction");
    let status = coordinator.status(now + 2_000).unwrap();
    assert_eq!(status.installed_version, "1.0.2");
    assert_eq!(status.phase, Phase::Idle);
    assert!(status.code.is_none() && !status.draining && status.available_version.is_none());
    assert!(store.journal().unwrap().pending.is_none(), "an older release is never accepted again");
    assert_eq!(host.installs.get(), 0);
}

#[path = "coordinator_stale_tests.rs"]
mod stale;
