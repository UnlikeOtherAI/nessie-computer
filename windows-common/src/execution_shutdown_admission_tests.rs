use super::*;
use serde_json::json;
fn fixture() -> Preparation {
    let value: serde_json::Value = serde_json::from_str(include_str!(
        "../../test/t3-session-runtime/fixtures/execution-shutdown.json"
    ))
    .unwrap();
    serde_json::from_value(value["preparation"].clone()).unwrap()
}
#[test]
fn shutdown_wire_matches_original_fixture_and_cannot_renew_or_retarget_its_complete_action() {
    let prepared = fixture();
    let now = prepared.issued_at_ms + 1;
    prepared.validate(now, false).unwrap();
    assert_eq!(
        prepared.slot_id,
        slot_id(&prepared.binding, &prepared.accepted_graph_nonce).unwrap()
    );
    let mut admitted = prepared.clone();
    admitted.issuer_key_id = Some("c".repeat(64));
    admitted.preparation_receipt_digest = Some(format!("sha256:{}", "d".repeat(64)));
    admitted.nonce = "e".repeat(64);
    admitted.issued_at_ms = now;
    admitted.expires_at_ms -= 1;
    admitted.validate(now, true).unwrap();
    assert!(admitted.matches(
        &prepared,
        &"c".repeat(64),
        &format!("sha256:{}", "d".repeat(64))
    ));
    for field in ["action", "binding", "observation", "evidence"] {
        let mut changed = serde_json::to_value(&admitted).unwrap();
        changed[field] = json!({"injected":true});
        assert!(serde_json::from_value::<Preparation>(changed).is_err());
    }
    let mut changed = admitted.clone();
    changed.expires_at_ms = prepared.observation.selection_at_ms + 5001;
    assert!(changed.validate(now, true).is_err());
    changed = admitted.clone();
    changed.observation.effects[0].source_run_id = "foreign".into();
    assert!(!changed.matches(
        &prepared,
        &"c".repeat(64),
        &format!("sha256:{}", "d".repeat(64))
    ));
    let mut raw = serde_json::to_value(prepared).unwrap();
    raw["sql"] = json!("SELECT caller");
    assert!(serde_json::from_value::<Preparation>(raw).is_err());
}
