//! Exact target selection on the inherited effect pipe. This is not an issuer.
//! Fresh permits come from the managed host's signed route and protected enrollment.
use serde_json::{json, Value};

fn present(value: &Value, keys: &[&str]) -> bool {
    keys.iter()
        .all(|key| value[*key].as_str().is_some_and(|s| !s.is_empty()))
}

pub fn is_t3(scope: &Value) -> bool {
    scope["kind"] == "t3-effect"
}

pub fn identity(scope: &Value) -> Option<Value> {
    if is_t3(scope) {
        let association = &scope["nativeAssociation"];
        if scope["version"] != 1
            || scope["purpose"] != "execute"
            || !present(
                scope,
                &[
                    "executorId",
                    "environmentId",
                    "threadId",
                    "providerSessionId",
                    "connectionEpoch",
                    "runtimeGeneration",
                    "correlationId",
                    "commandId",
                    "requestDigest",
                    "issuedAt",
                    "expiresAt",
                    "requestNonce",
                    "requestProofDigest",
                ],
            )
            || !["codex", "claude"]
                .iter()
                .any(|driver| association["driver"] == *driver)
            || !present(
                association,
                &["nativeId", "continuationHomeKey", "historyHomeKey"],
            )
        {
            return None;
        }
        return Some(json!({"kind":"t3-effect", "executorId":scope["executorId"],
            "environmentId":scope["environmentId"], "threadId":scope["threadId"],
            "providerSessionId":scope["providerSessionId"], "connectionEpoch":scope["connectionEpoch"],
            "runtimeGeneration":scope["runtimeGeneration"], "nativeAssociation":association}));
    }
    if scope.get("kind").is_some()
        || scope["purpose"] != "control"
        || !present(
            scope,
            &[
                "executorId",
                "originalOwnerGeneration",
                "ownerKey",
                "connectionEpoch",
                "commandId",
            ],
        )
        || scope["authorizationRevision"]
            .as_u64()
            .is_none_or(|revision| revision == 0)
    {
        return None;
    }
    let start = scope["admissions"]
        .get(0)
        .and_then(|row| row.get("startCommandId"))
        .or_else(|| scope.get("commandId"))?;
    Some(json!({"kind":"managed", "executorId":scope["executorId"],
        "originalOwnerGeneration":scope["originalOwnerGeneration"], "ownerKey":scope["ownerKey"],
        "connectionEpoch":scope["connectionEpoch"], "authorizationRevision":scope["authorizationRevision"],
        "startCommandId":start}))
}

pub fn same_session(first: &Value, next: &Value) -> bool {
    let Some(original) = identity(first) else {
        return false;
    };
    if identity(next) != Some(original) {
        return false;
    }
    if is_t3(first) {
        return true;
    }
    first["admissions"].get(0).is_none()
        || next["admissions"].get(0).is_none()
        || first["admissions"][0]["sessionId"] == next["admissions"][0]["sessionId"]
            && first["admissions"][0]["evidenceDigest"] == next["admissions"][0]["evidenceDigest"]
}

#[cfg(test)]
mod tests {
    use super::*;
    fn grant() -> Value {
        json!({"kind":"t3-effect", "version":1, "purpose":"execute", "executorId":"executor", "environmentId":"env",
            "threadId":"thread", "providerSessionId":"provider-session", "connectionEpoch":"7",
            "runtimeGeneration":"generation", "correlationId":"request", "commandId":"command",
            "requestDigest":"digest", "issuedAt":"issued", "expiresAt":"expires",
            "requestNonce":"nonce", "requestProofDigest":"proof",
            "nativeAssociation":{"driver":"codex", "nativeId":"native", "continuationHomeKey":"continue",
                "historyHomeKey":"history"}})
    }
    #[test]
    fn every_t3_and_native_identity_dimension_is_required_and_fixed() {
        let first = grant();
        for key in [
            "executorId",
            "environmentId",
            "threadId",
            "providerSessionId",
            "connectionEpoch",
            "runtimeGeneration",
        ] {
            let mut next = first.clone();
            next[key] = json!("different");
            assert!(!same_session(&first, &next));
            next[key] = Value::Null;
            assert!(identity(&next).is_none());
        }
        for key in [
            "driver",
            "nativeId",
            "continuationHomeKey",
            "historyHomeKey",
        ] {
            let mut next = first.clone();
            next["nativeAssociation"][key] = json!("different");
            assert!(!same_session(&first, &next));
            next["nativeAssociation"][key] = Value::Null;
            assert!(identity(&next).is_none());
        }
    }
    #[test]
    fn a_later_operation_selects_the_same_target_but_still_requires_its_own_permit() {
        let first = grant();
        let mut next = first.clone();
        next["commandId"] = json!("another-command");
        next["correlationId"] = json!("another-request");
        next["requestDigest"] = json!("another-digest");
        assert!(same_session(&first, &next));
        next["kind"] = json!("managed");
        assert!(!same_session(&first, &next));
    }
}
