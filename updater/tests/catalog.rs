use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{pkcs8::EncodePublicKey, Signer, SigningKey};
use nessie_executor_updater::{
    catalog::verify_manifest,
    protocol::{Channel, SeenRelease},
};
use serde_json::{json, Value};

fn manifest() -> Value {
    json!({ "format":1, "channel":"stable", "sequence":10, "version":"1.0.1",
        "sourceCommit":"a".repeat(40), "publishedAt":"2026-11-05T00:00:00.000Z",
        "expiresAt":"2026-11-07T00:00:00.000Z", "minimumUpdaterProtocol":1,
        "targets": { "windows-x64-msi": [{ "name":"executor.msi", "size":128,
            "sha256":"b".repeat(64),
            "url":"https://github.com/UnlikeOtherAI/nessie-executor/releases/download/executor-v1.0.1/executor.msi" }] }
    })
}
fn signed(value: &Value) -> (String, String) {
    let key = SigningKey::from_bytes(&[42; 32]);
    let payload = serde_json::to_vec(value).unwrap();
    let envelope = json!({ "payload":STANDARD.encode(&payload),
        "signature":STANDARD.encode(key.sign(&payload).to_bytes()) })
    .to_string();
    (
        envelope,
        key.verifying_key()
            .to_public_key_pem(Default::default())
            .unwrap(),
    )
}
fn now() -> i64 {
    chrono::DateTime::parse_from_rfc3339("2026-11-06T00:00:00.000Z")
        .unwrap()
        .timestamp_millis()
}

#[test]
fn accepted_bytes_survive_a_later_replay_floor_without_weakening_new_checks() {
    let (envelope, key) = signed(&manifest());
    let accepted = verify_manifest(&envelope, &key, now(), Channel::Stable, None).unwrap();
    let higher = SeenRelease {
        sequence: 11,
        digest: "c".repeat(64),
    };
    assert_eq!(
        verify_manifest(&envelope, &key, now(), Channel::Stable, Some(&higher)).unwrap_err(),
        "update.replayed_manifest"
    );
    // A protected pending journal retains exact bytes and their acceptance time.
    let resumed = verify_manifest(&envelope, &key, now(), Channel::Stable, None).unwrap();
    assert_eq!(resumed.digest, accepted.digest);
}

#[test]
fn signatures_expiry_and_immutable_asset_selection_are_independent_requirements() {
    let (envelope, key) = signed(&manifest());
    assert!(verify_manifest(&envelope, &key, now(), Channel::Stable, None).is_ok());
    assert_eq!(
        verify_manifest(&envelope, &key, now(), Channel::Preview, None).unwrap_err(),
        "update.wrong_channel"
    );
    assert_eq!(
        verify_manifest(&envelope, &key, now() + 172_800_000, Channel::Stable, None).unwrap_err(),
        "update.expired_manifest"
    );
    let mut tampered: Value = serde_json::from_str(&envelope).unwrap();
    tampered["payload"] = json!(STANDARD.encode(b"{\"format\":2}"));
    assert_eq!(
        verify_manifest(&tampered.to_string(), &key, now(), Channel::Stable, None).unwrap_err(),
        "update.invalid_signature"
    );
    for url in [
        "https://github.com/UnlikeOtherAI/nessie-executor/releases/download/latest/executor.msi",
        "https://evil.test/executor.msi",
    ] {
        let mut value = manifest();
        value["targets"]["windows-x64-msi"][0]["url"] = json!(url);
        let (envelope, key) = signed(&value);
        assert_eq!(
            verify_manifest(&envelope, &key, now(), Channel::Stable, None).unwrap_err(),
            "update.invalid_asset"
        );
    }
}
