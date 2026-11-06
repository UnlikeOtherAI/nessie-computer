//! Local controls return durable acknowledgements without waiting for HTTPS or installers.
#[cfg(windows)]
#[path = "broker_windows.rs"]
mod platform;

pub fn run() -> Result<(), String> {
    #[cfg(windows)]
    {
        platform::run()
    }
    #[cfg(not(windows))]
    {
        Err("update.installation_authorization_required".into())
    }
}
pub fn install() -> Result<(), String> {
    #[cfg(windows)]
    {
        super::host::initialize().map_err(str::to_owned)
    }
    #[cfg(not(windows))]
    {
        Err("update.installation_authorization_required".into())
    }
}
pub fn worker() -> Result<(), String> {
    #[cfg(windows)]
    {
        platform::worker()
    }
    #[cfg(not(windows))]
    {
        Err("update.installation_authorization_required".into())
    }
}
