//! Signed public machine controls and independent owner-only deletion handoff.
use super::{refused, PIN};
use crate::protocol::NativeError;
use nessie_windows_common::{custody::Operation, process::Process, service_channel};
use std::io::{Read, Write};

pub fn host_check() -> Result<(), NativeError> {
    crate::personal_state_context::require_release()?;
    let _release = nessie_windows_common::release::load(PIN).map_err(|_| refused())?;
    let reply = service_channel::call(&Operation::HostCheck, PIN).map_err(|_| refused())?;
    if reply["allowed"] != true || reply["guardVersion"] != 2 || reply["protocolVersion"] != 1 {
        return Err(refused());
    }
    println!("{reply}");
    Ok(())
}
pub fn status() -> Result<(), NativeError> {
    crate::personal_state_context::require_release()?;
    let _release = nessie_windows_common::release::load(PIN).map_err(|_| refused())?;
    let reply = service_channel::call(&Operation::Status, PIN).map_err(|_| refused())?;
    if reply["status"] != "verified"
        || reply["guardVersion"] != 2
        || reply["protocolVersion"] != 1
        || reply["epochs"].as_array().is_none()
    {
        return Err(refused());
    }
    println!("{reply}");
    Ok(())
}
fn cleanup_verified() -> Result<serde_json::Value, NativeError> {
    let reply = service_channel::call(&Operation::Status, PIN).map_err(|_| refused())?;
    if reply["status"] != "verified" || reply["guardVersion"] != 2 || reply["protocolVersion"] != 1
    {
        return Err(refused());
    }
    let epochs = reply["epochs"].as_array().ok_or_else(refused)?;
    if epochs.is_empty() {
        return Ok(serde_json::json!({"cleared":true}));
    }
    let _pins = crate::personal_state::verify_windows_deletion()?;
    for epoch in epochs {
        let epoch = epoch["epoch"].as_str().ok_or_else(refused)?;
        let result = service_channel::call(
            &Operation::Recover {
                epoch: epoch.into(),
            },
            PIN,
        )
        .map_err(|_| refused())?;
        if result["cleared"] != true {
            return Err(refused());
        }
    }
    Ok(serde_json::json!({"cleared":true}))
}
pub fn cleanup() -> Result<(), NativeError> {
    crate::personal_state_context::require_release()?;
    let _release = nessie_windows_common::release::load(PIN).map_err(|_| refused())?;
    let own = Process::open(std::process::id()).map_err(|_| refused())?;
    nessie_windows_common::process::interactive(&own).map_err(|_| refused())?;
    println!("{}", cleanup_verified()?);
    Ok(())
}
pub(super) fn cleanup_before_launch() {
    // Recovery failure never substitutes for successful launch registration.
    // A live/new credential actor remains fenced until the service's own proof.
    let _ = cleanup_verified();
}

pub fn inventory(nonce: &str) -> Result<(), NativeError> {
    crate::personal_state_context::require_release()?;
    let release = nessie_windows_common::release::load(PIN).map_err(|_| refused())?;
    let root = crate::personal_state_context::protected_root()?;
    let home = root.parent().and_then(|path| path.parent()).ok_or_else(refused)?;
    let installed = nessie_windows_common::installed::verify(&release, home, PIN)
        .map_err(|_| NativeError::new("EXECUTOR_INSTALLED_CUSTODY_UNVERIFIED"))?;
    let own = Process::open(std::process::id()).map_err(|_| refused())?;
    nessie_windows_common::process::interactive(&own).map_err(|_| refused())?;
    let mut frame = service_channel::call(
        &Operation::Inventory {
            nonce: nonce.into(),
        },
        PIN,
    )
    .map_err(|_| refused())?;
    installed.recheck().map_err(|_| NativeError::new("EXECUTOR_INSTALLED_CUSTODY_UNVERIFIED"))?;
    frame["root"] = serde_json::to_value(root).map_err(|_| refused())?;
    println!("{frame}");
    std::io::stdout().flush().map_err(|_| refused())?;
    let mut release = [0_u8; 8];
    if std::io::stdin().read_exact(&mut release).is_err() || &release != b"release\n" {
        return Err(refused());
    }
    let reply = service_channel::call(
        &Operation::Release {
            nonce: nonce.into(),
        },
        PIN,
    )
    .map_err(|_| refused())?;
    if reply["released"] != true {
        return Err(refused());
    }
    Ok(())
}

pub fn host_barrier(nonce: &str) -> Result<(), NativeError> {
    crate::personal_state_context::require_release()?;
    let _release = nessie_windows_common::release::load(PIN).map_err(|_| refused())?;
    let reply = service_channel::call(
        &Operation::HostAcquire {
            nonce: nonce.into(),
        },
        PIN,
    )
    .map_err(|_| refused())?;
    if reply["acquired"] != true {
        return Err(refused());
    }
    println!(
        "{}",
        serde_json::json!({"status":"verified","protocolVersion":1,"nonce":nonce})
    );
    std::io::stdout().flush().map_err(|_| refused())?;
    let mut release = [0_u8; 8];
    if std::io::stdin().read_exact(&mut release).is_err() || &release != b"release\n" {
        return Err(refused());
    }
    let reply = service_channel::call(
        &Operation::HostRelease {
            nonce: nonce.into(),
        },
        PIN,
    )
    .map_err(|_| refused())?;
    if reply["released"] != true {
        return Err(refused());
    }
    Ok(())
}

pub fn protection(epoch: &str, clear: bool) -> Result<(), NativeError> {
    crate::personal_state_context::require_release()?;
    let _release = nessie_windows_common::release::load(PIN).map_err(|_| refused())?;
    let own = Process::open(std::process::id()).map_err(|_| refused())?;
    nessie_windows_common::process::interactive(&own).map_err(|_| refused())?;
    let _pins = if clear {
        Some(crate::personal_state::verify_windows_deletion()?)
    } else {
        None
    };
    let operation = if clear {
        Operation::Clear {
            epoch: epoch.into(),
        }
    } else {
        Operation::Revoke {
            epoch: epoch.into(),
        }
    };
    let reply = service_channel::call(&operation, PIN).map_err(|_| refused())?;
    if reply[if clear { "cleared" } else { "revoked" }] != true {
        return Err(refused());
    }
    println!("{reply}");
    Ok(())
}
