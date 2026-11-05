//! Whether this app starts a connection it runs again after it stops without
//! being asked to. It is on unless the person turned it off, so an absent
//! value means on. Connections the Windows service runs are the service's to
//! restart, whatever this says.

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
    use crate::registry;
    const KEY: &str = "Software\\UnlikeOtherAI\\Nessie Executor";
    const NAME: &str = "RestartStoppedConnections";

    pub fn enabled() -> Result<bool, String> {
        registry::read_string(HKEY_CURRENT_USER, KEY, Some(NAME))
            .map(|value| value.as_deref() != Some("0"))
            .map_err(|_| "Could not read the restart setting.".to_owned())
    }

    pub fn set(enabled: bool) -> Result<(), String> {
        registry::write_string(HKEY_CURRENT_USER, KEY, Some(NAME), if enabled { "1" } else { "0" })
            .map_err(|_| "Could not change the restart setting.".to_owned())
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn enabled() -> Result<bool, String> { Err("Windows only.".into()) }
    pub fn set(_: bool) -> Result<(), String> { Err("Windows only.".into()) }
}

pub use platform::{enabled, set};
