//! Fixed local update operations. Privileged installation never runs JavaScript.
mod broker;
mod channel;
mod host;
#[cfg(unix)]
pub(super) mod admission_unix;
#[cfg(unix)]
mod unix_runtime;
#[cfg(unix)]
mod unix_setup;
#[cfg(unix)]
mod unix_process;
#[cfg(unix)]
pub(crate) mod unix_clearance;
#[cfg(unix)]
pub(crate) mod unix_health;
#[cfg(unix)]
mod unix_package;
#[cfg(unix)]
mod unix_legacy;
#[cfg(unix)]
mod broker_unix;
#[cfg(target_os = "macos")]
mod macos_applications;

use crate::protocol::NativeError;
use nessie_executor_updater::protocol::Request;
use std::io::Read;

fn rejected() -> NativeError {
    NativeError::new("EXECUTOR_UPDATE_COORDINATOR_UNAVAILABLE")
}

pub fn control() -> Result<(), NativeError> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(16_385)
        .read_to_end(&mut bytes)
        .map_err(|_| rejected())?;
    if bytes.len() > 16_384 {
        return Err(rejected());
    }
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| rejected())?;
    let response = channel::call(&request).map_err(|_| rejected())?;
    println!(
        "{}",
        serde_json::to_string(&response).map_err(|_| rejected())?
    );
    Ok(())
}

pub fn service() -> Result<(), NativeError> {
    broker::run().map_err(|_| rejected())
}
pub fn install() -> Result<(), NativeError> {
    broker::install().map_err(|_| rejected())
}
pub fn uninstall() -> Result<(), NativeError> {
    host::platform::uninstall().map_err(|_| rejected())
}
pub fn worker() -> Result<(), NativeError> {
    broker::worker().map_err(|_| rejected())
}

pub fn reopen_application() -> Result<(), NativeError> {
    #[cfg(target_os = "macos")]
    { macos_applications::reopen().map_err(|_| rejected()) }
    #[cfg(not(target_os = "macos"))]
    { Err(rejected()) }
}
