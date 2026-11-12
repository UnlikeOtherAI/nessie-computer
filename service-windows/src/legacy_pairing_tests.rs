use super::*;

fn command() -> PairCommand {
    PairCommand {
        api_base_url: "https://api.nessie.works".into(),
        enrollment_id: "enrollment".into(),
        challenge: "challenge".into(),
        workspace_root: "C:\\workspace".into(),
    }
}
fn secure(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())
}
const OWNER: Option<&str> = Some("S-1-5-21-123");

#[test]
fn original_input_and_owner_are_required_after_a_restart_and_keys_are_not_erased() {
    let root = tempfile::tempdir().unwrap();
    let original = command();
    let attempt = LegacyPairing::open(root.path(), &original, OWNER, secure).unwrap();
    secure(&attempt.staging).unwrap();
    fs::write(
        attempt.staging.join("executor-pairing.json"),
        "retained-key-and-request",
    )
    .unwrap();
    assert!(
        LegacyPairing::open(root.path(), &original, OWNER, secure).is_err(),
        "one kernel lock"
    );
    drop(attempt);
    let recovered = LegacyPairing::open(root.path(), &original, OWNER, secure).unwrap();
    assert_eq!(
        fs::read_to_string(recovered.staging.join("executor-pairing.json")).unwrap(),
        "retained-key-and-request"
    );
    assert!(recovered.completed().unwrap().is_none());
    drop(recovered);
    for change in 0..5 {
        let mut changed = command();
        let mut owner = OWNER;
        match change {
            0 => changed.api_base_url = "https://another.example".into(),
            1 => changed.challenge = "different".into(),
            2 => changed.workspace_root = "C:\\other".into(),
            3 => owner = Some("S-1-5-21-999"),
            _ => owner = None,
        }
        assert!(LegacyPairing::open(root.path(), &changed, owner, secure).is_err());
    }
    let attempt = LegacyPairing::open(root.path(), &original, OWNER, secure).unwrap();
    let result = attempt
        .record("executor".into(), "fingerprint".into())
        .unwrap();
    drop(attempt);
    assert_eq!(
        LegacyPairing::open(root.path(), &original, OWNER, secure)
            .unwrap()
            .completed()
            .unwrap(),
        Some(result)
    );
}

#[test]
fn unbound_old_staging_is_preserved_and_cannot_be_claimed_by_a_new_caller() {
    let root = tempfile::tempdir().unwrap();
    let staging = pending_root(root.path()).join("enrollment");
    secure(&staging).unwrap();
    fs::write(staging.join("executor-pairing.json"), "original-key").unwrap();
    assert!(LegacyPairing::open(root.path(), &command(), OWNER, secure).is_err());
    assert_eq!(
        fs::read_to_string(staging.join("executor-pairing.json")).unwrap(),
        "original-key"
    );
}
