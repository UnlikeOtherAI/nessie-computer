//! Platform installers implement the fixed native coordinator contract.
use nessie_executor_updater::{
    catalog::UpdateResult,
    coordinator::{Installed, Installer},
    protocol::{Manifest, Target},
};
use std::path::{Path, PathBuf};

#[cfg(windows)]
#[path = "host_windows.rs"]
pub(super) mod platform;
#[cfg(unix)]
#[path = "host_unix.rs"]
pub(super) mod platform;

pub struct Host;
impl Installer for Host {
    fn installation_status(&self) -> UpdateResult<(Installed, bool)> {
        #[cfg(unix)]
        { platform::installation_status() }
        #[cfg(windows)]
        { Ok((self.installed()?, self.target().is_ok())) }
    }
    fn set_draining(&self, draining: bool, restart_ready: bool) -> UpdateResult<()> {
        #[cfg(windows)]
        {
            {
            let mut admission = nessie_windows_common::update_admission::Admission::acquire(true)
                .map_err(|_| "update.admission_busy")?;
            if draining && !restart_ready { platform::capture_drain()?; }
            admission
                .set_draining(draining, restart_ready)
                .map_err(|_| "update.state_unavailable")?;
            }
            if !draining || restart_ready { platform::resume_applications(!draining)?; }
            Ok(())
        }
        #[cfg(unix)]
        {
            platform::set_draining(draining, restart_ready)
        }
    }
    fn target(&self) -> UpdateResult<Target> {
        #[cfg(windows)]
        {
            platform::target()
        }
        #[cfg(unix)]
        {
            platform::target()
        }
    }
    fn installed(&self) -> UpdateResult<Installed> {
        #[cfg(windows)]
        {
            platform::installed()
        }
        #[cfg(unix)]
        {
            platform::installed()
        }
    }
    fn verify_publishers(&self, manifest: &Manifest, directory: &Path) -> UpdateResult<()> {
        #[cfg(windows)]
        {
            platform::verify_publishers(manifest, directory)
        }
        #[cfg(unix)]
        {
            platform::verify_publishers(manifest, directory)
        }
    }
    fn replace_when_clear(
        &self,
        manifest: &Manifest,
        directory: &Path,
        begin: &mut dyn FnMut() -> UpdateResult<()>,
    ) -> UpdateResult<bool> {
        #[cfg(windows)]
        {
            platform::replace_when_clear(manifest, directory, begin)
        }
        #[cfg(unix)]
        {
            platform::replace_when_clear(manifest, directory, begin)
        }
    }
    fn confirm_restarted(&self, manifest: &Manifest) -> UpdateResult<bool> {
        #[cfg(windows)]
        {
            platform::confirm_restarted(manifest)
        }
        #[cfg(unix)]
        {
            platform::confirm_restarted(manifest)
        }
    }
}

pub fn root() -> UpdateResult<PathBuf> {
    #[cfg(windows)]
    {
        nessie_windows_common::update_admission::root().map_err(|_| "update.state_unavailable")
    }
    #[cfg(target_os = "linux")]
    {
        Ok(PathBuf::from("/var/lib/nessie-executor/updates"))
    }
    #[cfg(target_os = "macos")]
    {
        Ok(PathBuf::from(
            "/Library/Application Support/Nessie Executor/updates",
        ))
    }
}

#[cfg(windows)]
pub(super) use platform::{initialize, verify_worker, worker_image};
