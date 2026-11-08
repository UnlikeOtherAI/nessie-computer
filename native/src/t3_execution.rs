//! Fixed execution-purpose companion entry points. No arbitrary signing/approval operation.
use crate::protocol::NativeError;
use nessie_windows_common::{
    custody::Operation,
    execution::{now_ms, Challenge, Descriptor, Launch, Request, SignedAdmission},
    process::Process,
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchInput {
    admission: SignedAdmission,
    launch: Launch,
    provider_session_id: String,
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
        "launch" => std::process::exit(launch(input()?)?),
        _ => return Err(refused()),
    };
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, &result).map_err(|_| refused())?;
    output
        .write_all(b"\n")
        .and_then(|()| output.flush())
        .map_err(|_| refused())
}
fn launch(value: LaunchInput) -> Result<i32, NativeError> {
    use crate::job_run::imp::{kill_on_close_job, parent_process, resume, terminate_job};
    use std::{
        os::windows::{io::AsRawHandle, process::CommandExt},
        process::{Command, Stdio},
    };
    use windows_sys::Win32::{
        Foundation::{HANDLE, WAIT_OBJECT_0},
        System::{
            JobObjects::AssignProcessToJobObject,
            Threading::{WaitForMultipleObjects, CREATE_NO_WINDOW, CREATE_SUSPENDED, INFINITE},
        },
    };
    value.launch.validate().map_err(|_| refused())?;
    if !nessie_windows_common::execution::identifier(&value.provider_session_id) {
        return Err(refused());
    }
    let admission: nessie_windows_common::execution::Admission =
        serde_json::from_str(&value.admission.payload).map_err(|_| refused())?;
    admission
        .validate(now_ms().map_err(|_| refused())?)
        .map_err(|_| refused())?;
    // Compare exact canonical bytes locally before asking the protected service for a finite permit.
    let digest = nessie_windows_common::execution::value_digest(
        &serde_json::to_value(&value.launch).map_err(|_| refused())?,
    )
    .map_err(|_| refused())?;
    if admission.launch_digest.as_deref() != Some(digest.as_str()) {
        return Err(refused());
    }
    let lease = crate::managed_windows::acquire_host()?;
    let result = (|| {
        let permit = call(Request::Launch {
            admission: value.admission,
        })?;
        if permit["permitted"] != true {
            return Err(refused());
        }
        let deadline = permit["expiresAtMs"].as_u64().ok_or_else(refused)?;
        let service_generation: nessie_windows_common::custody::Generation =
            serde_json::from_value(permit["service"].clone()).map_err(|_| refused())?;
        let service = Process::open(service_generation.pid).map_err(|_| refused())?;
        if service.generation != service_generation || !service.alive() {
            return Err(refused());
        }
        service.signed(PIN).map_err(|_| refused())?;
        if now_ms().map_err(|_| refused())? >= deadline {
            return Err(refused());
        }
        let parent = parent_process()?;
        let job = kill_on_close_job()?;
        let _image = nessie_windows_common::release::pin_execution_image(std::path::Path::new(
            &value.launch.command,
        ))
        .map_err(|_| refused())?;
        let mut child = Command::new(&value.launch.command)
            .args(&value.launch.args)
            .current_dir(&value.launch.cwd)
            .env_clear()
            .envs(&value.launch.environment)
            .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|_| refused())?;
        let started = (|| {
            let service_sid = service_channel::service_account_sid().map_err(|_| refused())?;
            nessie_windows_common::peer_inspection::allow_process_for(
                child.as_raw_handle() as HANDLE,
                &service_sid,
            )
            .map_err(|_| refused())?;
            if unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) } == 0 {
                return Err(refused());
            }
            nessie_windows_common::peer_inspection::allow_execution_pipe_observer()
                .map_err(|_| refused())?;
            let stdout = child.stdout.take().ok_or_else(refused)?;
            let output = std::io::stdout();
            let observed = call(Request::Observe {
                executor_id: admission.binding.executor_id,
                reservation_id: admission.reservation_id,
                child_pid: child.id(),
                stdout_handle: stdout.as_raw_handle() as usize as u64,
                output_handle: output.as_raw_handle() as usize as u64,
                provider_session_id: value.provider_session_id,
            })?;
            drop(stdout); // The service now owns the sole reader; it forwards every byte.
            if observed["observing"] != true
                || now_ms().map_err(|_| refused())? >= deadline
                || !service.alive()
                || !resume(&child)
            {
                return Err(refused());
            }
            Ok(())
        })();
        if let Err(error) = started {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        // Generic provider stdin is deliberately not forwarded. The reviewed original
        // serializer must supply an independently admitted bootstrap/frame transport.
        let handles = [child.as_raw_handle() as HANDLE, parent.0, service.handle.0];
        let status = unsafe { WaitForMultipleObjects(3, handles.as_ptr(), 0, INFINITE) };
        let code = if status == WAIT_OBJECT_0 {
            child.wait().ok().and_then(|s| s.code()).unwrap_or(125)
        } else {
            125
        };
        terminate_job(&job)?;
        let _ = child.wait();
        Ok(code)
    })();
    crate::managed_windows::release_host(&lease)?;
    result
}
