//! Fixed execution-purpose companion entry points. No arbitrary signing/approval operation.
use crate::protocol::NativeError;
use nessie_windows_common::{
    custody::Operation,
    execution::{Challenge, Descriptor, Launch, Request, SignedAdmission},
    service_channel,
};
use serde::Deserialize;
use serde_json::Value;
use std::io::{BufRead, Read, Write};
const PIN: Option<&str> = option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");
fn refused() -> NativeError {
    NativeError::new("EXECUTOR_T3_EXECUTION_REFUSED")
}
fn call(request: Request) -> Result<Value, NativeError> {
    service_channel::call(&Operation::Execution { request }, PIN).map_err(|_| refused())
}
fn input<T: serde::de::DeserializeOwned>() -> Result<T, NativeError> {
    let mut bytes = Vec::new();
    std::io::BufReader::new(std::io::stdin().lock().take(65537))
        .read_until(b'\n', &mut bytes)
        .map_err(|_| refused())?;
    if bytes.len() > 65536 || !bytes.ends_with(b"\n") {
        return Err(refused());
    }
    serde_json::from_slice(&bytes).map_err(|_| refused())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Offer {
    executor_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    executor_id: String,
    reservation_id: String,
    provider_session_id: String,
    launch: Launch,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GraphInput {
    inspection: SignedAdmission,
    resource_id: String,
    graph: nessie_windows_common::execution::Graph,
}
pub fn run(mode: &str) -> Result<(), NativeError> {
    crate::personal_state_context::require_release()?;
    let _release = nessie_windows_common::release::load(PIN).map_err(|_| refused())?;
    let result = match mode {
        "offer" => {
            let value: Offer = input()?;
            call(Request::Offer {
                executor_id: value.executor_id,
            })?
        }
        "enroll" => {
            let challenge: Challenge = input()?;
            let descriptor: Descriptor = serde_json::from_value(call(Request::Review {
                challenge: challenge.clone(),
            })?)
            .map_err(|_| refused())?;
            crate::execution_approval::approve(&challenge, &descriptor)?;
            call(Request::Approve { challenge })?
        }
        "graph" => {
            let value: GraphInput = input()?;
            call(Request::Graph {
                inspection: value.inspection,
                resource_id: value.resource_id,
                graph: value.graph,
            })?
        }
        "reserve" => call(Request::Reserve {
            admission: input()?,
        })?,
        "prepare" => {
            let value: Prepare = input()?;
            call(Request::Prepare {
                executor_id: value.executor_id,
                reservation_id: value.reservation_id,
                provider_session_id: value.provider_session_id,
                launch: value.launch,
            })?
        }
        "associate" => call(Request::Associate {
            admission: input()?,
        })?,
        _ => return Err(refused()),
    };
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, &result).map_err(|_| refused())?;
    output
        .write_all(b"\n")
        .and_then(|()| output.flush())
        .map_err(|_| refused())
}
