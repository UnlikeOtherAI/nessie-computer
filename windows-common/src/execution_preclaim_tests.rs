use super::*;
use serde_json::{json, Value};
fn fixture() -> (Preclaim, Value) {
    let value: Value = serde_json::from_str(include_str!(
        "../../test/t3-session-runtime/fixtures/execution-preclaim.json"
    ))
    .unwrap();
    (
        serde_json::from_value(value["preparation"].clone()).unwrap(),
        value,
    )
}
#[test]
fn preclaim_identity_agrees_with_shared_original_unicode_fixture() {
    let (p, f) = fixture();
    p.validate(p.issued_at_ms, false).unwrap();
    assert_eq!(p.claim_id, f["expectedClaimId"]);
    assert_eq!(
        claim_id(
            &p.binding,
            &p.accepted_graph_nonce,
            &p.bound.observation.effect_id,
            p.bound.observation.attempt_count
        )
        .unwrap(),
        p.claim_id
    );
    assert!(p.validate(p.expires_at_ms, false).is_err());
    assert!(p.validate(p.issued_at_ms - 1, false).is_err());
}
#[test]
fn preclaim_admission_preserves_all_evidence_and_can_only_shorten_expiry() {
    let (p, _) = fixture();
    let issuer = "a".repeat(64);
    let digest = format!("sha256:{}", "b".repeat(64));
    let mut admitted = p.clone();
    admitted.issuer_key_id = Some(issuer.clone());
    admitted.preparation_receipt_digest = Some(digest.clone());
    admitted.nonce = "c".repeat(64);
    admitted.issued_at_ms += 1;
    admitted.expires_at_ms -= 1;
    admitted.validate(admitted.issued_at_ms, true).unwrap();
    assert!(admitted.matches(&p, &issuer, &digest));
    let saved = serde_json::to_value(&admitted).unwrap();
    for pointer in [
        "/claimId",
        "/acceptedGraphNonce",
        "/evidence/resourceId",
        "/evidence/destinationDatabaseIdentity",
        "/evidence/settingsDigest",
        "/evidence/custody/serviceImageDigest",
        "/bound/observation/rowDigest",
        "/bound/original/messageId",
        "/bound/original/releaseRunEventDigest",
        "/binding/sourceEvidenceDigest",
        "/binding/relayHmac",
    ] {
        let mut changed = saved.clone();
        *changed.pointer_mut(pointer).unwrap() = json!("replacement");
        let changed: Preclaim = serde_json::from_value(changed).unwrap();
        assert!(!changed.matches(&p, &issuer, &digest), "{pointer}");
    }
    admitted.expires_at_ms = p.expires_at_ms + 1;
    assert!(!admitted.matches(&p, &issuer, &digest));
    assert!(admitted.validate(admitted.issued_at_ms, true).is_err());
}
#[test]
fn preclaim_rejects_extra_fields_and_unbound_or_retargeted_rows() {
    let (p, f) = fixture();
    let mut extra = f["preparation"].clone();
    extra["providerSessionId"] = json!("not-preclaim-authority");
    assert!(serde_json::from_value::<Preclaim>(extra).is_err());
    for (pointer, value) in [
        ("/bound/observation/attemptCount", json!(-1)),
        ("/bound/observation/commandId", json!("foreign-release")),
        (
            "/bound/observation/effectType",
            json!("provider-runtime.continue"),
        ),
        ("/bound/original/threadId", json!("foreign-thread")),
        (
            "/bound/original/providerInstanceId",
            json!("foreign-provider"),
        ),
        ("/bound/original/parentCommandId", json!("foreign-parent")),
        ("/binding/sourceEvidenceDigest", Value::Null),
    ] {
        let mut changed = f["preparation"].clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        let changed: Preclaim = serde_json::from_value(changed).unwrap();
        assert!(
            changed.validate(p.issued_at_ms, false).is_err(),
            "{pointer}"
        );
    }
}
