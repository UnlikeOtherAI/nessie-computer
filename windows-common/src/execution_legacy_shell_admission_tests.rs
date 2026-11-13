use super::*;
use serde_json::{json, Value};
fn fixture() -> (Preparation, Value) {
    let value: Value = serde_json::from_str(include_str!(
        "../../test/t3-session-runtime/fixtures/execution-legacy-shell.json"
    ))
    .unwrap();
    (
        serde_json::from_value(value["preparation"].clone()).unwrap(),
        value,
    )
}
#[test]
fn legacy_shell_slot_is_shared_with_typescript_and_cannot_renew_by_changing_plan() {
    let (mut p, value) = fixture();
    p.validate(p.issued_at_ms, false).unwrap();
    assert_eq!(p.slot_id, value["expectedSlotId"].as_str().unwrap());
    assert_eq!(
        slot_id(&p.binding, &p.accepted_graph_nonce).unwrap(),
        p.slot_id
    );
    p.observation.plan_digest = format!("sha256:{}", "0".repeat(64));
    assert_eq!(
        slot_id(&p.binding, &p.accepted_graph_nonce).unwrap(),
        p.slot_id
    );
    assert!(p.validate(p.expires_at_ms, false).is_err());
    assert!(p.validate(p.issued_at_ms - 1, false).is_err());
}
#[test]
fn legacy_shell_admission_keeps_all_original_target_resource_and_graph_fields_and_only_shortens() {
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
        "/slotId",
        "/acceptedGraphNonce",
        "/binding/commandId",
        "/binding/relayHmac",
        "/evidence/resourceId",
        "/evidence/destinationDatabaseIdentity",
        "/evidence/custody/serviceImageDigest",
        "/observation/planDigest",
        "/observation/targets/0/threadId",
        "/observation/targets/0/projectId",
    ] {
        let mut changed = saved.clone();
        *changed.pointer_mut(pointer).unwrap() = json!("replacement");
        let changed: Preparation = serde_json::from_value(changed).unwrap();
        assert!(!changed.matches(&p, &issuer, &digest), "{pointer}");
    }
    admitted.expires_at_ms = p.expires_at_ms + 1;
    assert!(!admitted.matches(&p, &issuer, &digest));
    assert!(admitted.validate(admitted.issued_at_ms, true).is_err());
}
#[test]
fn legacy_shell_codec_rejects_extra_fields_other_actions_provider_ids_and_overlong_windows() {
    let (p, value) = fixture();
    for key in ["providerSessionId", "reservationId", "inputs"] {
        let mut extra = value["preparation"].clone();
        extra[key] = json!("not-authority");
        assert!(serde_json::from_value::<Preparation>(extra).is_err());
    }
    let mut changed = p.clone();
    changed.action = "runtime-recover".into();
    assert!(changed.validate(p.issued_at_ms, false).is_err());
    changed = p.clone();
    changed.expires_at_ms = p.issued_at_ms + 5001;
    assert!(changed.validate(p.issued_at_ms, false).is_err());
}
