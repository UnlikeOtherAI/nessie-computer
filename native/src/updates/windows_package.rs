//! Authenticated MSI inspection and the fixed privileged installation transaction.
use super::runtime::{runtime, system, wide, ERROR, PIN};
use nessie_executor_updater::{
    catalog::UpdateResult,
    protocol::{Manifest, Target},
};
use nessie_windows_common::{
    release,
    update_admission::{self, Admission},
};
use nessie_windows_provenance::{collect_signature_facts, decide_release_signature};
use std::{
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
fn package(manifest: &Manifest, directory: &Path) -> UpdateResult<PathBuf> {
    let assets = manifest
        .targets
        .get(&Target::WindowsX64Msi)
        .ok_or("update.unsupported_platform")?;
    if assets.len() != 1 || !assets[0].name.ends_with("_x64.msi") {
        return Err("update.invalid_package");
    }
    Ok(directory.join(&assets[0].name))
}
pub fn verify_publishers(manifest: &Manifest, directory: &Path) -> UpdateResult<()> {
    let package = package(manifest, directory)?;
    let _pin = release::pin_protected(&package, false).map_err(|_| "update.invalid_package")?;
    decide_release_signature(PIN, collect_signature_facts(&package))
        .map_err(|_| "update.wrong_publisher")?;
    for (property, expected) in [
        ("ProductName", "Nessie Executor"),
        ("UpgradeCode", "{9A1C6D2E-4F3B-4A7D-9C1E-2B8F5D6A4E10}"),
        ("ProductVersion", manifest.version.as_str()),
        ("NessieManagedRuntimeGuardVersion", "2"),
    ] {
        if msi_property(&package, property)? != expected {
            return Err("update.invalid_package");
        }
    }
    Ok(())
}

fn msi_property(path: &Path, property: &str) -> UpdateResult<String> {
    use windows_sys::Win32::System::ApplicationInstallationAndServicing::*;
    struct Handle(u32);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                MsiCloseHandle(self.0);
            }
        }
    }
    let mut database = 0;
    if unsafe {
        MsiOpenDatabaseW(
            wide(path.as_os_str()).as_ptr(),
            std::ptr::null(),
            &mut database,
        )
    } != 0
    {
        return Err("update.invalid_package");
    }
    let database = Handle(database);
    let sql = wide(std::ffi::OsStr::new(&format!(
        "SELECT `Value` FROM `Property` WHERE `Property`='{property}'"
    )));
    let mut view = 0;
    if unsafe { MsiDatabaseOpenViewW(database.0, sql.as_ptr(), &mut view) } != 0 {
        return Err("update.invalid_package");
    }
    let view = Handle(view);
    if unsafe { MsiViewExecute(view.0, 0) } != 0 {
        return Err("update.invalid_package");
    }
    let mut record = 0;
    if unsafe { MsiViewFetch(view.0, &mut record) } != 0 {
        return Err("update.invalid_package");
    }
    let record = Handle(record);
    let mut buffer = [0_u16; 256];
    let mut length = buffer.len() as u32;
    if unsafe { MsiRecordGetStringW(record.0, 1, buffer.as_mut_ptr(), &mut length) } != 0
        || length > 255
    {
        return Err("update.invalid_package");
    }
    String::from_utf16(&buffer[..length as usize]).map_err(|_| "update.invalid_package")
}

pub fn replace_when_clear(
    manifest: &Manifest,
    directory: &Path,
    begin: &mut dyn FnMut() -> UpdateResult<()>,
) -> UpdateResult<bool> {
    system()?;
    let mut admission = Admission::acquire(true).map_err(|_| "update.admission_busy")?;
    // Resume a crash after Windows committed the package but before the
    // coordinator recorded Restarting. New daemons need no second MSI run.
    if let Ok(current) = runtime() {
        if current.version.as_deref() == Some(manifest.version.as_str())
            && current.source_commit.as_deref() == Some(manifest.source_commit.as_str())
        {
            admission
                .set_target(Some(current.digest))
                .map_err(|_| "update.state_unavailable")?;
            return Ok(true);
        }
    }
    if !super::clearance::custody_idle()? {
        return Ok(false);
    }
    if !super::clearance::ready(false)? {
        return Ok(false);
    }
    verify_publishers(manifest, directory)?;
    begin()?;
    admission
        .set_target(Some(String::new()))
        .map_err(|_| "update.state_unavailable")?;
    // No command shell, user environment, transform or caller-selected property.
    let system_dir =
        update_admission::known_folder(&windows_sys::Win32::UI::Shell::FOLDERID_System)
            .map_err(|_| ERROR)?;
    let windows = update_admission::known_folder(&windows_sys::Win32::UI::Shell::FOLDERID_Windows)
        .map_err(|_| ERROR)?;
    let temporary = super::runtime::installer_temporary()?;
    let result = Command::new(system_dir.join("msiexec.exe"))
        .args(["/i"])
        .arg(package(manifest, directory)?)
        .args([
            "/qn",
            "/norestart",
            "REBOOT=ReallySuppress",
            "MSIRESTARTMANAGERCONTROL=DisableShutdown",
        ])
        .env_clear()
        .env("SystemRoot", &windows)
        .env("WINDIR", &windows)
        .env("TEMP", &temporary)
        .env("TMP", &temporary)
        .current_dir(&temporary)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|_| "update.installer_failed")?;
    if !matches!(result.code(), Some(0 | 3010)) {
        return Err("update.installer_failed");
    }
    let release = runtime()?;
    if release.version.as_deref() != Some(&manifest.version)
        || release.source_commit.as_deref() != Some(&manifest.source_commit)
    {
        return Err("update.installed_release_unverified");
    }
    admission
        .set_target(Some(release.digest))
        .map_err(|_| "update.state_unavailable")?;
    Ok(true)
}
