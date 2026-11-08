//! Local controls return durable acknowledgements without waiting for HTTPS or installers.
#[cfg(windows)]
#[path = "broker_windows.rs"]
mod platform;

pub fn run() -> Result<(), String> {
    #[cfg(windows)]
    {
        platform::run()
    }
    #[cfg(unix)]
    {
        super::broker_unix::run()
    }
}
pub fn install() -> nessie_executor_updater::catalog::UpdateResult<()> {
    #[cfg(windows)]
    {
        super::host::initialize()
    }
    #[cfg(unix)]
    {
        super::host::platform::initialize()
    }
}
pub fn worker() -> Result<(), String> {
    #[cfg(windows)]
    {
        platform::worker()
    }
    #[cfg(unix)]
    {
        super::broker_unix::worker()
    }
}
