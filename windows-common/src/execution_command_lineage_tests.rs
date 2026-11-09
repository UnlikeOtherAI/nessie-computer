use super::*;
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../test/t3-session-runtime/fixtures/original-command-lineage.json"
    ))
    .unwrap()
}
fn capture() -> Capture {
    let f = fixture();
    Capture::new(
        "digest".into(),
        f["parent"].as_str().unwrap().into(),
        f["thread"].as_str().unwrap().into(),
        f["provider"].as_str().unwrap().into(),
        5000,
        0,
    )
}
#[test]
fn native_capture_expiry_is_terminal_across_wall_clock_rollback_and_monotonic_elapsed_time() {
    let c = capture();
    assert!(c.current(5000).is_err());
    assert!(c.current(4999).is_err());
    let c = Capture::new(
        "graph".into(),
        "parent".into(),
        "thread".into(),
        "provider".into(),
        5000,
        4999,
    );
    std::thread::sleep(std::time::Duration::from_millis(5));
    assert!(c.current(0).is_err());
}
fn accepted(f: &Value) -> AcceptedInitial {
    let parent = f["parent"].as_str().unwrap();
    let child = f["edges"][0]["commandId"].as_str().unwrap();
    let thread = f["thread"].as_str().unwrap();
    AcceptedInitial {
        run_id: f["run"].as_str().unwrap().into(),
        parent_command_type: "thread.create".into(),
        parent_receipt_digest: receipt(&f["receipts"][0], parent, thread, &["thread.create"]).unwrap(),
        initial_receipt_digest: receipt(&f["receipts"][1], child, thread, &["message.dispatch"]).unwrap(),
        initial_run_event_digest: run_event(
            &f["events"][0],
            &f["receipts"][1],
            child,
            thread,
            f["run"].as_str().unwrap(),
            f["message"].as_str().unwrap(),
            f["provider"].as_str().unwrap(),
            false,
        )
        .unwrap(),
    }
}
fn edge(f: &Value, index: usize) -> Edge {
    serde_json::from_value(f["edges"][index].clone()).unwrap()
}
#[test]
fn original_live_capture_requires_both_accepted_predecessors_and_preserves_exact_replay() {
    let f = fixture();
    let mut c = capture();
    let initial = accepted(&f);
    let released = AcceptedRelease {
        receipt_digest: value_digest(&f["receipts"][2]).unwrap(),
        run_event_digest: value_digest(&f["events"][1]).unwrap(),
    };
    for _ in 0..2 {
        c.record(&edge(&f, 0), None, None, 1).unwrap();
        c.record(&edge(&f, 1), Some(initial.clone()), None, 1).unwrap();
        c.record(&edge(&f, 2), None, None, 1).unwrap();
        c.record(&edge(&f, 3), None, Some(released.clone()), 1).unwrap();
    }
    let evidence = c.evidence(1).unwrap();
    assert_eq!(evidence.parent_command_id, f["parent"]);
    assert_eq!(evidence.release_command_id, f["edges"][3]["commandId"]);
    assert_eq!(evidence.run_id, f["run"]);
    c.close();
    assert!(c.evidence(1).is_err());
    assert!(c.record(&edge(&f, 0), None, None, 1).is_err());
}
#[test]
fn missing_accepted_creation_expiry_and_any_edge_substitution_are_terminal() {
    let f = fixture();
    for index in 1..4 {
        let mut c = capture();
        assert!(c.record(&edge(&f, index), None, None, 1).is_err());
        assert!(c.record(&edge(&f, 0), None, None, 1).is_err());
    }
    for field in ["parentCommandId", "commandId", "threadId", "messageId"] {
        let mut c = capture();
        c.record(&edge(&f, 0), None, None, 1).unwrap();
        let mut changed = f["edges"][0].clone();
        changed[field] = Value::String("replacement".into());
        assert!(c
            .record(&serde_json::from_value(changed).unwrap(), None, None, 1)
            .is_err());
        assert!(c.record(&edge(&f, 0), None, None, 1).is_err());
    }
    let mut c = capture();
    assert!(c.record(&edge(&f, 0), None, None, 5000).is_err());
    assert!(c.evidence(4999).is_err());
}
#[test]
fn sql_run_evidence_uses_exact_actual_child_correlation_and_message_instance_status() {
    let f = fixture();
    let child = f["edges"][0]["commandId"].as_str().unwrap();
    let check = |event: &Value| {
        run_event(
            event,
            &f["receipts"][1],
            child,
            f["thread"].as_str().unwrap(),
            f["run"].as_str().unwrap(),
            f["message"].as_str().unwrap(),
            f["provider"].as_str().unwrap(),
            false,
        )
    };
    assert!(check(&f["events"][0]).is_ok());
    for mode in 0..7 {
        let mut changed = f["events"][0].clone();
        match mode {
            0 => changed["correlation_id"] = f["parent"].clone(),
            1 => changed["sequence"] = serde_json::json!(9),
            2 => changed["actor_kind"] = serde_json::json!("provider"),
            3 => changed["metadata_json"] = serde_json::json!("{\"runId\":\"wrong\",\"runId\":\"run:雪:one\"}"),
            _ => {
                let mut payload: Value = serde_json::from_str(changed["payload_json"].as_str().unwrap()).unwrap();
                payload[match mode {
                    4 => "userMessageId",
                    5 => "providerInstanceId",
                    _ => "status",
                }] = serde_json::json!("replacement");
                changed["payload_json"] = Value::String(payload.to_string());
            }
        }
        assert!(check(&changed).is_err());
    }
}
