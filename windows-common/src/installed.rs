//! Installed launchers can restart after a process inventory; verify them separately.
use crate::{
    custody::REJECTED,
    process::{interactive, Process},
    registry::read_launch_string,
    release::{self, Release},
};
use std::{
    fs::File,
    path::{Path, PathBuf},
};
use windows_sys::Win32::System::Registry::{
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_SUBKEY_WOW6432KEY, RRF_SUBKEY_WOW6464KEY,
};
#[path = "installed_paths.rs"]
mod paths;

#[derive(PartialEq, Eq)]
struct Registrations {
    service: String,
    account: String,
    trays: Vec<String>,
    desktop: bool,
}
fn registrations() -> Result<Registrations, String> {
    let service_key = r"SYSTEM\CurrentControlSet\Services\NessieExecutor";
    let read = |name| {
        read_launch_string(HKEY_LOCAL_MACHINE, service_key, Some(name), 0)
            .map_err(|_| REJECTED)?
            .ok_or_else(|| REJECTED.to_owned())
    };
    let mut entries = Registrations {
        service: read("ImagePath")?,
        account: read("ObjectName")?,
        trays: Vec::new(),
        desktop: false,
    };
    for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        for view in [RRF_SUBKEY_WOW6464KEY, RRF_SUBKEY_WOW6432KEY] {
            if let Some(command) = read_launch_string(
                root,
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                Some("NessieExecutorTray"),
                view,
            )
            .map_err(|_| REJECTED)?
            {
                entries.trays.push(command);
            }
            if read_launch_string(
                root,
                r"Software\Classes\nessie\shell\open\command",
                None,
                view,
            )
            .map_err(|_| REJECTED)?
            .is_some()
            {
                entries.desktop = true;
            }
        }
    }
    Ok(entries)
}
fn executable(command: &str, expected: &str) -> Result<PathBuf, String> {
    let command = command.trim();
    let path = if let Some(quoted) = command.strip_prefix('"') {
        let (path, rest) = quoted.split_once('"').ok_or(REJECTED)?;
        if !rest.trim().is_empty() {
            return Err(REJECTED.into());
        }
        path
    } else {
        if command.chars().any(char::is_whitespace) {
            return Err(REJECTED.into());
        }
        command
    };
    if path.chars().any(char::is_control) || path.contains(['%', '"']) {
        return Err(REJECTED.into());
    }
    let path = PathBuf::from(path);
    if !path.is_absolute()
        || !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(expected))
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(REJECTED.into());
    }
    Ok(path)
}
pub struct InstalledFloor {
    observed: Registrations,
    home: PathBuf,
    release: PathBuf,
    _releases: Vec<Release>,
    _executables: Vec<File>,
}
impl InstalledFloor {
    pub fn recheck(&self) -> Result<(), String> {
        if self.observed != registrations()? {
            return Err(REJECTED.into());
        }
        paths::verify(&self.home, &self.release)
    }
}
/// Must run as the independently verified interactive owner, so HKCU is never
/// the service account's hive. Desktop's existing user-writable installations
/// and unversioned CLI wrappers are unsupported, even when no process is live;
/// only the MSI's own command line in the selected release folder may be on PATH.
pub fn verify(
    selected: &Release,
    home: &Path,
    pin: Option<&str>,
) -> Result<InstalledFloor, String> {
    interactive(&Process::open(std::process::id())?)?;
    let consumers = selected.launch_consumers.as_ref().ok_or(REJECTED)?;
    let observed = registrations()?;
    if !observed
        .account
        .eq_ignore_ascii_case(crate::SERVICE_ACCOUNT)
        || observed.desktop
    {
        return Err(REJECTED.into());
    }
    paths::verify(home, &selected.runtime.root)?;
    let mut programs = vec![executable(
        &observed.service,
        "nessie-executor-service.exe",
    )?];
    for tray in &observed.trays {
        programs.push(executable(tray, "nessie-executor-tray.exe")?);
    }
    let mut floor = InstalledFloor {
        observed,
        home: home.to_path_buf(),
        release: selected.runtime.root.clone(),
        _releases: Vec::new(),
        _executables: Vec::new(),
    };
    // The tray may have no login entry, but it is a shipped direct launch consumer.
    programs.push(selected.runtime.root.join("nessie-executor-tray.exe"));
    for executable in programs {
        let file = release::pin_launcher(&executable, pin)?;
        let expected = if executable
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("nessie-executor-service.exe"))
        {
            &consumers.service_sha256
        } else {
            &consumers.tray_sha256
        };
        release::verify_launcher_digest(&file, expected)?;
        floor._executables.push(file);
        let release = release::load_at(&executable, pin)?;
        if release.digest != selected.digest {
            return Err(REJECTED.into());
        }
        floor._releases.push(release);
    }
    floor.recheck()?;
    Ok(floor)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_fixed_absolute_service_and_tray_commands_are_eligible() {
        assert!(executable(
            r#""C:\Program Files\Nessie Executor\nessie-executor-tray.exe""#,
            "nessie-executor-tray.exe"
        )
        .is_ok());
        assert!(executable(
            r"C:\Nessie\nessie-executor-service.exe",
            "nessie-executor-service.exe"
        )
        .is_ok());
        for command in [
            r#""C:\Nessie\nessie-executor-service.exe" --override"#,
            r"%INSTALLROOT%\nessie-executor-service.exe",
            r"nessie-executor-service.exe",
            r"C:\Nessie\..\nessie-executor-service.exe",
            r"C:\Nessie\other.exe",
        ] {
            assert!(executable(command, "nessie-executor-service.exe").is_err());
        }
    }
}
