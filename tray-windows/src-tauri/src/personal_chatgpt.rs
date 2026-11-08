//! Public local account controls. Neither paths nor OAuth material arrive from WebView.
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::Stdio,
    sync::mpsc,
    time::Duration,
};

#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Operation {
    Status {
        #[serde(rename = "profileId", skip_serializing_if = "Option::is_none")]
        profile_id: Option<String>,
    },
    Start {
        #[serde(rename = "profileId", skip_serializing_if = "Option::is_none")]
        profile_id: Option<String>,
        #[serde(rename = "acknowledgeHostRestriction")]
        acknowledge_host_restriction: bool,
        #[serde(rename = "newProfileId", skip_serializing_if = "Option::is_none")]
        new_profile_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    Rename {
        #[serde(rename = "profileId")]
        profile_id: String,
        label: String,
    },
    Cancel {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    Disconnect {
        #[serde(rename = "profileId")]
        profile_id: String,
    },
    BackgroundConsent {
        #[serde(rename = "profileId")]
        profile_id: String,
        enabled: bool,
        #[serde(rename = "expectedRevision")]
        expected_revision: Option<u64>,
    },
}

fn public_operation(value: serde_json::Value) -> Result<serde_json::Value, String> {
    let operation: Operation =
        serde_json::from_value(value.clone()).map_err(|_| "Invalid local account action.")?;
    let id = match &operation {
        Operation::Status { profile_id } | Operation::Start { profile_id, .. } => {
            profile_id.as_ref()
        }
        Operation::Cancel { operation_id } => Some(operation_id),
        Operation::Disconnect { profile_id } | Operation::BackgroundConsent { profile_id, .. }
        | Operation::Rename { profile_id, .. } => {
            Some(profile_id)
        }
    };
    if id
        .is_some_and(|id| id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
    {
        return Err("Invalid local sign-in identity.".into());
    }
    let (new_id, label) = match &operation {
        Operation::Start { new_profile_id, label, .. } => (new_profile_id.as_ref(), label.as_ref()),
        Operation::Rename { label, .. } => (None, Some(label)),
        _ => (None, None),
    };
    if new_id.is_some_and(|id| id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
        || label.is_some_and(|label| label.trim().is_empty() || label.chars().count() > 80)
    {
        return Err("Invalid local connection name or identity.".into());
    }
    if let Operation::BackgroundConsent {
        expected_revision, ..
    } = &operation
    {
        if value.get("expectedRevision").is_none()
            || expected_revision
                .is_some_and(|revision| revision == 0 || revision > 9_007_199_254_740_991)
        {
            return Err("Invalid background permission revision.".into());
        }
    }
    serde_json::to_value(operation).map_err(|_| "Invalid local account action.".into())
}

fn service_actor_reference(executor_id: &str) -> Result<(&'static str, String), String> {
    if executor_id.len() != 36
        || !executor_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err("Invalid paired computer identity.".into());
    }
    Ok(("--service-executor", executor_id.to_owned()))
}

fn operate(executor_id: &str, operation: serde_json::Value) -> Result<serde_json::Value, String> {
    let input = public_operation(operation)?;
    // Service-owned connections are public references. The signed stdin bridge
    // asks the service for fresh authority; no machine key is copied here.
    let (option, reference) = if crate::user_connections::owns(executor_id) {
        (
            "--state-dir",
            crate::user_connections::directory(executor_id)?
                .to_str()
                .ok_or("Invalid local connection path.")?
                .to_owned(),
        )
    } else {
        service_actor_reference(executor_id)?
    };
    let mut child = crate::user_runtime::command()?
        .args([
            "personal-chatgpt-local",
            "--operation-stdin",
            option,
            &reference,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Could not start the local account controller.")?;
    let mut pipe = child
        .stdin
        .take()
        .ok_or("Local account input unavailable.")?;
    let bytes = serde_json::to_vec(&input).map_err(|_| "Invalid local account action.")?;
    let supplied = pipe.write_all(&bytes);
    drop(pipe);
    let output = child
        .stdout
        .take()
        .ok_or("Local account response unavailable.")?;
    let (send, receive) = mpsc::sync_channel(1);
    // This thread retains the actual child until EOF and wait, including after
    // a missing/timed-out public ACK. Closing the console proves no clearance.
    std::thread::spawn(move || {
        let mut reader = BufReader::new(output);
        let mut frame = Vec::new();
        let result = reader
            .by_ref()
            .take(1_048_577)
            .read_until(b'\n', &mut frame)
            .map_err(|_| "Could not read the local account response.".to_owned())
            .and_then(|_| {
                if supplied.is_err() || frame.len() > 1_048_576 || !frame.ends_with(b"\n") {
                    Err("Local account response unavailable.".into())
                } else {
                    serde_json::from_slice(&frame)
                        .map_err(|_| "Invalid local account response.".into())
                }
            });
        let _ = send.send(result);
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
        let _ = child.wait();
        // The native parent returns only after its complete Job Object is
        // empty. A separate interactive helper can now prove credential deletion
        // and ask the service for clearance without becoming a token holder.
        crate::custody_cleanup::attempt();
    });
    receive
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| "Local account check is still pending.")?
}

#[tauri::command]
pub async fn executor_personal_chatgpt(
    executor_id: String,
    operation: serde_json::Value,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || operate(&executor_id, operation))
        .await
        .map_err(|error| error.to_string())?
}

/// The existing status interface resumes only profiles carrying an intentional
/// update marker. It reads no provider credentials in this native process.
pub fn resume_updates() {
    use std::{collections::BTreeSet, sync::{Mutex, OnceLock}};
    static CHECKING: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
    let crate::state::ServiceView::Reachable { executors } = crate::commands::view() else { return; };
    for executor in executors {
        let id = executor.executor_id;
        let checking = CHECKING.get_or_init(Default::default);
        let Ok(mut held) = checking.lock() else { return; };
        if !held.insert(id.clone()) { continue; }
        drop(held);
        std::thread::spawn(move || {
            let _ = operate(&id, serde_json::json!({"operation":"status"}));
            if let Ok(mut held) = checking.lock() { held.remove(&id); }
        });
    }
}

#[tauri::command]
pub fn executor_chatgpt_usage(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url("https://chatgpt.com/settings/usage", None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::public_operation;
    use serde_json::json;
    #[test]
    fn a_selected_service_plan_connection_opens_the_user_actor_with_only_its_public_reference() {
        let executor = "b83e9273-6e74-4a75-bada-9c3d5b80b493";
        assert_eq!(
            super::service_actor_reference(executor).unwrap(),
            ("--service-executor", executor.to_owned())
        );
        assert!(super::service_actor_reference(r"C:\Users\owner\executor-state.json").is_err());
    }
    #[test]
    fn account_bridge_refuses_arbitrary_input_and_preserves_explicit_consent() {
        assert!(
            public_operation(json!({"operation":"status","stateDirectory":"C:\\elsewhere"}))
                .is_err()
        );
        assert!(
            public_operation(json!({"operation":"start","acknowledgeHostRestriction":false}))
                .is_ok()
        );
        assert!(
            public_operation(json!({"operation":"background-consent","profileId":"bad",
            "enabled":true,"expectedRevision":null}))
            .is_err()
        );
        assert!(public_operation(json!({"operation":"status","token":"secret"})).is_err());
    }
}
