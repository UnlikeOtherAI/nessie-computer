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

pub struct Host;
impl Installer for Host {
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
        #[cfg(not(windows))]
        {
            let _ = (draining, restart_ready);
            Err("update.installation_authorization_required")
        }
    }
    fn target(&self) -> UpdateResult<Target> {
        #[cfg(windows)]
        {
            platform::target()
        }
        #[cfg(not(windows))]
        {
            Err("update.installation_authorization_required")
        }
    }
    fn installed(&self) -> UpdateResult<Installed> {
        #[cfg(windows)]
        {
            platform::installed()
        }
        #[cfg(unix)]
        {
            let release = crate::managed_release::installed()
                .map_err(|_| "update.installed_release_unverified")?;
            Ok(Installed {
                version: release.version.ok_or("update.bootstrap_required")?,
                source_commit: release.source_commit.ok_or("update.bootstrap_required")?,
            })
        }
    }
    fn verify_publishers(&self, manifest: &Manifest, directory: &Path) -> UpdateResult<()> {
        #[cfg(windows)]
        {
            platform::verify_publishers(manifest, directory)
        }
        #[cfg(not(windows))]
        {
            let _ = (manifest, directory);
            Err("update.installation_authorization_required")
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
        #[cfg(not(windows))]
        {
            let _ = (manifest, directory, begin);
            Err("update.installation_authorization_required")
        }
    }
    fn confirm_restarted(&self, manifest: &Manifest) -> UpdateResult<bool> {
        #[cfg(windows)]
        {
            platform::confirm_restarted(manifest)
        }
        #[cfg(not(windows))]
        {
            let _ = manifest;
            Ok(false)
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
