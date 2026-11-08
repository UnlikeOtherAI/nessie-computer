//! A failure stops once the release it was for is installed, even by hand.
use super::*;

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
