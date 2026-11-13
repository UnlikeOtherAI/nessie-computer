use super::*;
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../test/t3-session-runtime/fixtures/execution-shutdown.json"
    ))
    .unwrap()
}
#[test]
fn shutdown_native_selection_matches_the_actual_original_pure_selector_and_codecs() {
    let fixture = fixture();
    let policy =
        Policy::read(serde_json::to_vec(&fixture["settings"]).unwrap().as_slice()).unwrap();
    let at = fixture["preparation"]["observation"]["selectionAtMs"]
        .as_u64()
        .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let value = &case["projection"];
        let projection = Projection {
            thread: value["thread"].clone(),
            sections: value
                .as_object()
                .unwrap()
                .iter()
                .filter(|(key, _)| key.as_str() != "thread")
                .map(|(key, value)| (key.clone(), value.as_array().unwrap().clone()))
                .collect(),
        };
        let run = select(&projection, &policy, at)
            .unwrap()
            .map(|effect| effect.source_run_id);
        assert_eq!(
            serde_json::to_value(run).unwrap(),
            case["runId"],
            "{}",
            case["name"]
        );
    }
}
#[test]
fn shutdown_authority_digest_matches_original_full_inputs_and_exact_existing_slots() {
    let fixture = fixture();
    let policy =
        Policy::read(serde_json::to_vec(&fixture["settings"]).unwrap().as_slice()).unwrap();
    for value in [
        &fixture["preparation"]["observation"],
        &fixture["existingObservation"],
    ] {
        let expected: Observation = serde_json::from_value(value.clone()).unwrap();
        let actual = observe(
            &policy,
            expected.targets.clone(),
            expected.effects.clone(),
            expected.observed_at_ms,
            expected.selection_at_ms,
        )
        .unwrap();
        assert_eq!(actual, expected);
    }
    let expected: Observation =
        serde_json::from_value(fixture["existingObservation"].clone()).unwrap();
    let mut effect = expected.effects[0].clone();
    effect.existing_row_digest = None;
    bind_existing(&mut effect, Some(fixture["existingRow"].clone())).unwrap();
    assert_eq!(effect, expected.effects[0]);
    let mut changed = fixture["existingRow"].clone();
    changed["command_id"] = json!("foreign");
    assert!(bind_existing(&mut effect, Some(changed)).is_err());
    assert!(observe(
        &policy,
        expected.targets.clone(),
        expected.effects.clone(),
        expected.selection_at_ms + 5000,
        expected.selection_at_ms
    )
    .is_err());
}
#[test]
fn shutdown_policy_uses_original_defaults_overrides_and_rejects_bad_or_ambiguous_settings() {
    assert!(Policy::read(b"{}").unwrap().enabled);
    let policy = Policy::read(br#"{"continueThreadsAfterServerUpdate":false,"projectSettingsOverrides":{" chosen ":{"continueThreadsAfterServerUpdate":true}}}"#).unwrap();
    assert_eq!(policy.overrides.get("chosen"), Some(&true));
    for bytes in [
        br#"{"continueThreadsAfterServerUpdate":null}"#.as_slice(),
        br#"{"projectSettingsOverrides":[]}"#,
        br#"{"continueThreadsAfterServerUpdate":true,"continueThreadsAfterServerUpdate":false}"#,
    ] {
        assert!(Policy::read(bytes).is_err());
    }
}
