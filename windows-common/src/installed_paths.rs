//! Known inactive Desktop/CLI entrypoints, including persistent PATH registrations.
use crate::{custody::REJECTED, registry::read_launch_string, release::pin_protected};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};
use windows_sys::Win32::System::{
    Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
    SystemInformation::GetWindowsDirectoryW,
};

fn expand(value: &str, variables: &[(&str, String)]) -> Result<String, String> {
    let mut rest = value;
    let mut output = String::new();
    while let Some(start) = rest.find('%') {
        output.push_str(&rest[..start]);
        let tail = &rest[start + 1..];
        let end = tail.find('%').ok_or(REJECTED)?;
        let (_, replacement) = variables
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(&tail[..end]))
            .ok_or(REJECTED)?;
        if replacement.contains('%') {
            return Err(REJECTED.into());
        }
        output.push_str(replacement);
        rest = &tail[end + 1..];
    }
    output.push_str(rest);
    if output.len() > 65_536 || output.chars().any(char::is_control) {
        return Err(REJECTED.into());
    }
    Ok(output)
}
fn absent(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(REJECTED.into()), // Includes dangling links and unreadable entries.
    }
}
/// The command's name and its older name: a stray launcher may answer to either.
const COMMANDS: [&str; 2] = ["nessie-computer", "nessie-executor"];

/// The command line the MSI ships, byte for byte. `build-msi.mjs` copies this
/// file under both [`OFFICIAL_NAMES`] into the release folder it puts on the
/// machine PATH; the repository stores it with LF line endings everywhere.
const OFFICIAL_LAUNCHER: &[u8] = include_bytes!("../../packaging/windows/nessie-executor.cmd");
const OFFICIAL_NAMES: [&str; 2] = ["nessie-computer.cmd", "nessie-executor.cmd"];

/// Opens a launcher the way custody trusts it: production pins a protected
/// release file, so only administrators could ever change what it runs.
type Open<'a> = &'a dyn Fn(&Path) -> Result<File, String>;

/// Every file a PATH lookup of one of [`COMMANDS`] could run, and the old Desktop app.
fn launcher_names() -> Vec<String> {
    COMMANDS
        .iter()
        .flat_map(|command| ["", ".exe", ".cmd", ".bat", ".ps1"].map(|extension| format!("{command}{extension}")))
        .chain(std::iter::once("nessie-desktop.exe".to_owned()))
        .collect()
}

/// The verified release folder itself, compared component by component and
/// ignoring only ASCII case and a trailing separator. The release loader pins
/// every component of that path as a real directory, so any other spelling —
/// a short name, `..`, a link — is treated as a different folder.
fn release_folder(entry: &Path, release: &Path) -> bool {
    entry.components().count() == release.components().count()
        && entry
            .components()
            .zip(release.components())
            .all(|(entry, release)| entry.as_os_str().eq_ignore_ascii_case(release.as_os_str()))
}

/// A launcher name in one PATH folder must be absent. The one exception is the
/// MSI's own command line: one of its two names, in the verified release
/// folder, whose protected file holds exactly the shipped bytes.
fn check_launcher(folder: &Path, name: &str, release: &Path, open: Open) -> Result<(), String> {
    let path = folder.join(name);
    if absent(&path).is_ok() {
        return Ok(());
    }
    if !OFFICIAL_NAMES.contains(&name) || !release_folder(folder, release) {
        return Err(REJECTED.into());
    }
    let mut bytes = Vec::new();
    open(&path)?
        .take(OFFICIAL_LAUNCHER.len() as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| REJECTED)?;
    if bytes != OFFICIAL_LAUNCHER {
        return Err(REJECTED.into());
    }
    Ok(())
}

fn check_path(value: &str, release: &Path, open: Open) -> Result<(), String> {
    if value.len() > 65_536 {
        return Err(REJECTED.into());
    }
    let paths: Vec<_> = std::env::split_paths(value).collect();
    if paths.len() > 256 {
        return Err(REJECTED.into());
    }
    for path in paths {
        // Empty/relative PATH entries can launch from an unknown working directory.
        if !path.is_absolute() {
            return Err(REJECTED.into());
        }
        for name in launcher_names() {
            check_launcher(&path, &name, release, open)?;
        }
    }
    Ok(())
}
/// `release` is the verified installed release folder, the only place the
/// MSI's own command line may sit on PATH.
pub(super) fn verify(home: &Path, release: &Path) -> Result<(), String> {
    let protected = |path: &Path| pin_protected(path, false);
    let mut windows = vec![0_u16; 32_768];
    let size = unsafe { GetWindowsDirectoryW(windows.as_mut_ptr(), windows.len() as u32) } as usize;
    if size == 0 || size >= windows.len() {
        return Err(REJECTED.into());
    }
    let windows = String::from_utf16(&windows[..size]).map_err(|_| REJECTED)?;
    let program_files = read_launch_string(
        HKEY_LOCAL_MACHINE,
        r"SOFTWARE\Microsoft\Windows\CurrentVersion",
        Some("ProgramFilesDir"),
        0,
    )
    .map_err(|_| REJECTED)?
    .ok_or(REJECTED)?;
    let mut variables = vec![
        ("SystemRoot", windows.clone()),
        ("windir", windows),
        ("USERPROFILE", home.to_str().ok_or(REJECTED)?.to_owned()),
        ("ProgramFiles", program_files.clone()),
    ];
    for (name, key, default) in [
        ("APPDATA", "AppData", "AppData/Roaming"),
        ("LOCALAPPDATA", "Local AppData", "AppData/Local"),
    ] {
        let raw = read_launch_string(
            HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
            Some(key),
            0,
        )
        .map_err(|_| REJECTED)?;
        let directory = match raw {
            Some(value) => PathBuf::from(expand(&value, &variables)?),
            None => home.join(default),
        };
        if !directory.is_absolute() {
            return Err(REJECTED.into());
        }
        // Desktop's old per-user install and npm's CLI wrapper remain blockers
        // even when removed from PATH or unregistered as a URL handler.
        let npm = COMMANDS
            .iter()
            .flat_map(|command| [".cmd", ".ps1", ""].map(|extension| format!("npm/{command}{extension}")));
        for file in ["Nessie/nessie-desktop.exe".to_owned(), "Programs/Nessie/nessie-desktop.exe".to_owned()]
            .into_iter()
            .chain(npm)
        {
            absent(&directory.join(file))?;
        }
        variables.push((name, directory.to_str().ok_or(REJECTED)?.to_owned()));
    }
    absent(&PathBuf::from(&program_files).join("Nessie/nessie-desktop.exe"))?;
    for (root, key) in [
        (HKEY_CURRENT_USER, r"Environment"),
        (
            HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ),
    ] {
        if let Some(value) = read_launch_string(root, key, Some("Path"), 0).map_err(|_| REJECTED)? {
            check_path(&expand(&value, &variables)?, release, &protected)?;
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        check_path(path.to_str().ok_or(REJECTED)?, release, &protected)?;
    }
    Ok(())
}
#[cfg(test)]
#[path = "installed_paths_tests.rs"]
mod tests;
