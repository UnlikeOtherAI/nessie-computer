//! Fixed native package identity and publisher checks precede privileged replacement.
use super::{admission_unix, unix_runtime::{self, ERROR}};
#[cfg(target_os = "linux")]
use super::host::root;
use nessie_executor_updater::{catalog::UpdateResult, protocol::{Manifest, Target}};
use std::{io::{Read, Write},
    path::{Path, PathBuf}, process::{Command, Stdio}, time::{Duration, Instant}};
#[cfg(target_os = "linux")]
use std::{fs::{self, OpenOptions}, os::unix::fs::OpenOptionsExt};

pub(super) fn target() -> UpdateResult<Target> {
    if std::env::consts::ARCH != "x86_64" && std::env::consts::ARCH != "aarch64" {
        return Err("update.unsupported_platform");
    }
    #[cfg(target_os = "macos")]
    { if std::env::consts::ARCH == "aarch64" { Ok(Target::DarwinArm64Pkg) } else { Err("update.unsupported_platform") } }
    #[cfg(target_os = "linux")]
    {
        if std::env::consts::ARCH != "x86_64" { return Err("update.unsupported_platform"); }
        if Path::new("/usr/bin/dpkg-query").is_file() { Ok(Target::LinuxX64Deb) }
        else if Path::new("/usr/bin/rpm").is_file() { Ok(Target::LinuxX64Rpm) }
        else { Err("update.unsupported_platform") }
    }
}

pub(super) fn command(executable: &str) -> Command {
    let mut command = Command::new(executable);
    command.env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin").env("LC_ALL", "C")
        .current_dir("/").stdin(Stdio::null()).stderr(Stdio::null());
    command
}

/// Only bounded read-only inspectors use this deadline. An accepted package
/// transaction is never killed because a client or inspection deadline expired.
pub(super) fn inspect(mut command: Command, input: Option<Vec<u8>>) -> UpdateResult<String> {
    command.stdout(Stdio::piped());
    if input.is_some() { command.stdin(Stdio::piped()); }
    let mut child = command.spawn().map_err(|_| "update.package_inspection_failed")?;
    let writer = input.map(|input| {
        let stream = child.stdin.take();
        std::thread::spawn(move || stream.ok_or(std::io::ErrorKind::BrokenPipe.into())
            .and_then(|mut stream| stream.write_all(&input)))
    });
    let output = child.stdout.take().ok_or(ERROR)?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new(); output.take(65_537).read_to_end(&mut bytes).map(|_| bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Err(_) => { let _ = child.kill(); let _ = child.wait(); break false; },
            _ if Instant::now() >= deadline => { let _ = child.kill(); let _ = child.wait(); break false; },
            _ => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    if let Some(writer) = writer { writer.join().map_err(|_| ERROR)?.map_err(|_| ERROR)?; }
    let bytes = reader.join().map_err(|_| ERROR)?.map_err(|_| ERROR)?;
    if !success || bytes.len() > 65_536 { return Err("update.package_inspection_failed"); }
    String::from_utf8(bytes).map_err(|_| "update.invalid_package")
}

fn package(manifest: &Manifest, directory: &Path) -> UpdateResult<PathBuf> {
    let target = target()?;
    let assets = manifest.targets.get(&target).ok_or("update.unsupported_platform")?;
    let suffix = match target { Target::DarwinArm64Pkg => ".pkg", Target::LinuxX64Deb => ".deb",
        Target::LinuxX64Rpm => ".rpm", _ => return Err("update.unsupported_platform") };
    let packages: Vec<_> = assets.iter().filter(|asset| asset.name.ends_with(suffix)).collect();
    if packages.len() != 1 || assets.len() != if target == Target::DarwinArm64Pkg { 1 } else { 2 } {
        return Err("update.invalid_package");
    }
    Ok(directory.join(&packages[0].name))
}

#[cfg(target_os = "linux")]
fn linux_signature(package: &Path) -> UpdateResult<()> {
    const KEY: &[u8] = include_bytes!("../../../packaging/linux/keys/unlikeotherai-executor.gpg");
    let keyring = root()?.join("package-publisher.gpg");
    match OpenOptions::new().write(true).create_new(true).mode(0o444)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&keyring) {
        Ok(mut file) => { file.write_all(KEY).and_then(|()| file.sync_all()).map_err(|_| ERROR)?; },
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
        Err(_) => return Err(ERROR),
    }
    if fs::read(&keyring).map_err(|_| ERROR)? != KEY { return Err("update.wrong_publisher"); }
    let signature = package.with_file_name(format!("{}.asc", package.file_name().and_then(|name| name.to_str()).ok_or(ERROR)?));
    let mut verifier = command("/usr/bin/gpgv");
    verifier.arg("--homedir").arg(root()?).arg("--keyring").arg(keyring).arg(signature).arg(package);
    inspect(verifier, None).map_err(|_| "update.wrong_publisher")?;
    Ok(())
}

pub(super) fn verify_publishers(manifest: &Manifest, directory: &Path) -> UpdateResult<()> {
    unix_runtime::privileged()?;
    let package = package(manifest, directory)?;
    #[cfg(target_os = "macos")]
    {
        let team = option_env!("NESSIE_DESKTOP_SIGNING_TEAM_ID").filter(|team| team.len() == 10)
            .ok_or("update.wrong_publisher")?;
        let signature = inspect({ let mut value = command("/usr/sbin/pkgutil"); value.arg("--check-signature").arg(&package); value }, None)?;
        if !signature.lines().any(|line| line.trim().starts_with("1. Developer ID Installer: ")
            && line.trim().ends_with(&format!("({team})"))) { return Err("update.wrong_publisher"); }
        inspect({ let mut value = command("/usr/sbin/spctl"); value.args(["--assess", "--type", "install"]).arg(&package); value }, None)?;
        let metadata = inspect({ let mut value = command("/usr/bin/xar"); value.args(["-x", "-O", "-f"])
            .arg(&package).arg("PackageInfo"); value }, None)?;
        for (attribute, expected) in [("identifier", "com.unlikeotherai.nessie.executor.custody"), ("version", manifest.version.as_str())] {
            let actual = inspect({ let mut value = command("/usr/bin/xmllint");
                value.args(["--nonet", "--xpath", &format!("string(/pkg-info/@{attribute})"), "-"]); value }, Some(metadata.as_bytes().to_vec()))?;
            if actual.trim() != expected { return Err("update.invalid_package"); }
        }
    }
    #[cfg(target_os = "linux")]
    {
        linux_signature(&package)?;
        let mut query = match target()? {
            Target::LinuxX64Deb => { let mut value = command("/usr/bin/dpkg-deb");
                value.args(["--show", "--showformat=${Package}\n${Version}\n${Architecture}\n"]); value },
            Target::LinuxX64Rpm => { let mut value = command("/usr/bin/rpm");
                value.args(["-qp", "--queryformat", "%{NAME}\n%{VERSION}\n%{ARCH}\n"]); value },
            _ => return Err("update.unsupported_platform"),
        };
        query.arg(&package);
        let metadata = inspect(query, None)?;
        let fields: Vec<_> = metadata.lines().collect();
        let architecture = if target()? == Target::LinuxX64Deb { "amd64" } else { "x86_64" };
        if fields.len() != 3 || fields[0] != "nessie-executor" || fields[2] != architecture
            || fields[1] != manifest.version && fields[1] != format!("{}-1", manifest.version) { return Err("update.invalid_package"); }
    }
    Ok(())
}

pub(super) fn replace_when_clear(manifest: &Manifest, directory: &Path,
    begin: &mut dyn FnMut() -> UpdateResult<()>) -> UpdateResult<bool> {
    unix_runtime::privileged()?;
    let _barrier = crate::managed_machine_barrier::MachineBarrier::acquire().map_err(|_| "update.admission_busy")?;
    let mut maintenance = admission_unix::read()?;
    if let Ok(release) = crate::managed_release::installed() {
        if release.version.as_deref() == Some(&manifest.version) && release.source_commit.as_deref() == Some(&manifest.source_commit) {
            maintenance.target = Some(release.digest); admission_unix::write(&maintenance)?; return Ok(true);
        }
        if let Some(version) = &release.version {
            if nessie_executor_updater::catalog::compare_versions(version, &manifest.version)? == std::cmp::Ordering::Greater {
                return Err("update.downgrade_refused");
            }
        }
    }
    if !super::unix_clearance::ready()? { return Ok(false); }
    verify_publishers(manifest, directory)?;
    begin()?;
    maintenance.target = Some(String::new());
    admission_unix::write(&maintenance)?;
    let package = package(manifest, directory)?;
    let mut install = match target()? {
        Target::DarwinArm64Pkg => { let mut value = command("/usr/sbin/installer"); value.arg("-pkg").arg(package).args(["-target", "/"]); value },
        Target::LinuxX64Deb => { let mut value = command("/usr/bin/dpkg"); value.arg("--install").arg(package); value },
        Target::LinuxX64Rpm => { let mut value = command("/usr/bin/rpm"); value.arg("--upgrade").arg(package); value },
        _ => return Err("update.unsupported_platform"),
    };
    if !install.stdout(Stdio::null()).status().map_err(|_| "update.installer_failed")?.success() { return Err("update.installer_failed"); }
    let release = crate::managed_release::installed().map_err(|_| ERROR)?;
    if release.version.as_deref() != Some(&manifest.version) || release.source_commit.as_deref() != Some(&manifest.source_commit) { return Err(ERROR); }
    maintenance.target = Some(release.digest);
    admission_unix::write(&maintenance)?;
    Ok(true)
}
