use super::*;

#[test]
fn original_wire_defaults_and_duplicate_reference_positions_are_preserved() {
    let reference = json!({"provider":" vault ","reference":" op://vault/item/field "});
    let source = json!({"providerInstances":{"chosen":{"driver":"codex","displayName":" Display ",
        "environment":[{"name":"LITERAL"},{"name":" API_KEY ","secret":reference,"value":"ignored"},
        {"name":"SECOND","secret":reference}],"config":{"enabled":true,"homePath":"C:\\held"}}},
        "secretProviders":{"vault":{"kind":"one_password","label":" Label ","config":{"account":"example"}}}});
    let observed = observe(&serde_json::to_vec(&source).unwrap(), "chosen", "codex").unwrap();
    assert_eq!(
        observed
            .selection
            .environment
            .iter()
            .map(|s| s.index)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(observed.selection.references.len(), 2);
    assert!(observed.selection.config.is_empty());
    let expected = json!({"driver":"codex","displayName":"Display","environment":[
        {"name":"LITERAL","value":"","sensitive":false},
        {"name":"API_KEY","value":"","sensitive":true,"secret":{"provider":"vault","reference":"op://vault/item/field"}},
        {"name":"SECOND","value":"","sensitive":true,"secret":{"provider":"vault","reference":"op://vault/item/field"}}],
        "config":{"enabled":true,"homePath":"C:\\held"}});
    assert_eq!(
        observed.provider_config_digest,
        value_digest(&expected).unwrap()
    );
    assert_eq!(observed.accounts, vec!["example", "example"]);
}
#[test]
fn defaults_do_not_create_config_references_or_secret_providers() {
    let source = br#"{"providerInstances":{"chosen":{"driver":"claudeAgent"}}}"#;
    let observed = observe(source, "chosen", "claude").unwrap();
    assert!(observed.selection.environment.is_empty());
    assert!(observed.selection.config.is_empty());
    assert_eq!(
        observed.provider_config_digest,
        value_digest(&json!({"driver":"claudeAgent"})).unwrap()
    );
    assert_eq!(
        observed.secret_providers_digest,
        value_digest(&json!({})).unwrap()
    );
    assert!(observe(source, "chosen", "codex").is_err());
}
#[test]
fn original_op_grammar_refuses_argument_and_template_injection() {
    for invalid in [
        "op://v/i",
        "op://v/i/f/extra/extra",
        "op://v/i/{{field}}",
        "op://v/i/f\n",
        "op://v/i/f?x=y&z=1",
        "op://v/i/f?X=y",
        "op://v/i/ leading",
        "op://v/i/trailing ",
    ] {
        assert!(!op_reference(invalid), "{invalid}");
    }
    for valid in [
        "op://vault/item/field",
        "op://v/i/section/f?attribute=id",
        "op://vault name/item/field",
    ] {
        assert!(op_reference(valid), "{valid}");
    }
    for invalid in ["", "--account", "account value", "x\ny"] {
        assert!(!account(invalid));
    }
}
