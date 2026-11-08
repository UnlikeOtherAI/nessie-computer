//! The selected pairing owns endpoint state; the renderer never names a state path.
#[tauri::command]
pub async fn executor_inference_connections(executor_id: String, operation: serde_json::Value)
    -> Result<serde_json::Value, String> {
    let operation = nessie_windows_common::inference_control::validate(operation)?;
    tauri::async_runtime::spawn_blocking(move || {
        match crate::pipe_client::call(&serde_json::json!({"command":"inferenceConnections",
            "executorId":executor_id,"operation":operation}))? {
            crate::pipe_client::ServiceResponse::InferenceConnections(value) => Ok(value),
            _ => Err("Could not read inference connections.".into()),
        }
    }).await.map_err(|_| "Could not update inference connections.")?
}
