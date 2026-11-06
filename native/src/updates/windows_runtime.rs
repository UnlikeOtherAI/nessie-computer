//! Windows Installer is invoked only with an authenticated vendor package.
use crate::updates::host::root;
use nessie_executor_updater::{catalog::UpdateResult, coordinator::Installed, protocol::Target};
use nessie_windows_common::{
    process, release,
    update_admission::{self},
};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::windows::ffi::OsStrExt,
};

pub(super) const PIN: Option<&str> = option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");
pub(super) const ERROR: &str = "update.installed_release_unverified";

pub(super) fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

pub(in crate::updates) fn system() -> UpdateResult<()> {
    let current = process::Process::open(std::process::id()).map_err(|_| ERROR)?;
    if current.sid != "S-1-5-18" || current.session != 0 {
        return Err("update.installation_authorization_required");
    }
    Ok(())
}
pub(in crate::updates) fn runtime() -> UpdateResult<release::Release> {
    let program_files =
        update_admission::known_folder(&windows_sys::Win32::UI::Shell::FOLDERID_ProgramFiles)
            .map_err(|_| ERROR)?;
    let mut release = release::load_at(
        &program_files.join("Nessie Executor/nessie-executor-native.exe"),
        PIN,
    )
    .map_err(|_| ERROR)?;
    release.verify_launch_consumers(PIN).map_err(|_| ERROR)?;
    Ok(release)
}
pub(in crate::updates) fn service_root() -> UpdateResult<PathBuf> {
    let path = update_admission::known_folder(&windows_sys::Win32::UI::Shell::FOLDERID_ProgramData)
        .map_err(|_| ERROR)?
        .join("Nessie Executor");
    crate::state_security::verify_service_directory(path.to_str().ok_or(ERROR)?)
        .map_err(|_| ERROR)?;
    Ok(path)
}

pub(in crate::updates) fn installed() -> UpdateResult<Installed> {
    let release = runtime()?;
    let version = release.version.ok_or("update.bootstrap_required")?;
    let source_commit = release.source_commit.ok_or("update.bootstrap_required")?;
    nessie_executor_updater::catalog::compare_versions(&version, &version)?;
    if source_commit.len() != 40 || !source_commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ERROR);
    }
    Ok(Installed {
        version,
        source_commit,
    })
}
pub(in crate::updates) fn target() -> UpdateResult<Target> {
    if !cfg!(target_arch = "x86_64") {
        return Err("update.unsupported_platform");
    }
    let root = root()?;
    let _pin = release::pin_protected(&root, true)
        .map_err(|_| "update.installation_authorization_required")?;
    if !root.join("admission.lock").is_file() {
        return Err("update.installation_authorization_required");
    }
    Ok(Target::WindowsX64Msi)
}

fn hash(path: &Path) -> UpdateResult<String> {
    let mut file = File::open(path).map_err(|_| ERROR)?;
    let mut digest = Sha256::new();
    let mut bytes = [0_u8; 65536];
    loop {
        let count = file.read(&mut bytes).map_err(|_| ERROR)?;
        if count == 0 {
            break;
        }
        digest.update(&bytes[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

/// An atomic protected directory creation never adopts a user-precreated path.
fn directory(path: &Path) -> UpdateResult<()> {
    use windows_sys::Win32::{
        Foundation::{GetLastError, LocalFree, ERROR_ALREADY_EXISTS},
        Security::{
            Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SECURITY_ATTRIBUTES,
        },
        Storage::FileSystem::CreateDirectoryW,
    };
    if !path.exists() {
        let mut descriptor = std::ptr::null_mut();
        let sddl = wide(std::ffi::OsStr::new(
            "O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;GRGX;;;AU)",
        ));
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(ERROR);
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let created = unsafe { CreateDirectoryW(wide(path.as_os_str()).as_ptr(), &attributes) };
        let error = unsafe { GetLastError() };
        unsafe { LocalFree(descriptor) };
        if created == 0 && error != ERROR_ALREADY_EXISTS {
            return Err(ERROR);
        }
    }
    release::pin_protected(path, true).map_err(|_| ERROR)?;
    Ok(())
}

pub(super) fn installer_temporary() -> UpdateResult<PathBuf> {
    let path = root()?.join("installer-temp");
    directory(&path)?;
    Ok(path)
}

pub(in crate::updates) fn initialize() -> UpdateResult<()> {
    system()?;
    // The installer calls the exact newly installed helper, not caller code.
    let release = runtime()?;
    let executable = std::env::current_exe().map_err(|_| ERROR)?;
    if hash(&executable)? != hash(&release.runtime.native_helper)? {
        return Err(ERROR);
    }
    let root = root()?;
    directory(&root)?;
    for (name, bytes) in [
        ("admission.lock", b"nessie-update-admission-v1\n".as_slice()),
        (
            "maintenance.json",
            b"{\"format\":1,\"target\":null}".as_slice(),
        ),
    ] {
        let path = root.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(bytes).map_err(|_| ERROR)?;
                file.sync_all().map_err(|_| ERROR)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(ERROR),
        }
        release::pin_protected(&path, false).map_err(|_| ERROR)?;
    }
    // Verify an existing fence, preserving it through repair or a major upgrade.
    // A replacing worker may hold the persistent lock throughout this MSI.
    // Setup never clears or takes ownership of its existing maintenance state.
    let worker = worker_image()?;
    super::setup::configure(&worker)?;
    Ok(())
}

pub(in crate::updates) fn worker_image() -> UpdateResult<PathBuf> {
    system()?;
    let installed = match runtime() {
        Ok(installed) => installed,
        Err(_) => {
            // A partial MSI cannot remove the only process capable of repair.
            let digest =
                nessie_executor_updater::storage::Store::new(root()?).worker_reference()?;
            let path = root()?
                .join("bin")
                .join(digest)
                .join("nessie-computer-updater.exe");
            verify_worker_at(&path)?;
            return Ok(path);
        }
    };
    let digest = hash(&installed.runtime.native_helper)?;
    let bin = root()?.join("bin");
    directory(&bin)?;
    let version = bin.join(&digest);
    directory(&version)?;
    let output = version.join("nessie-computer-updater.exe");
    if !output.exists() {
        let draft = version.join("worker.draft");
        if draft.exists() {
            release::pin_protected(&draft, false).map_err(|_| ERROR)?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&draft)
            .map_err(|_| ERROR)?;
        let mut input = File::open(&installed.runtime.native_helper).map_err(|_| ERROR)?;
        std::io::copy(&mut input, &mut file).map_err(|_| ERROR)?;
        file.sync_all().map_err(|_| ERROR)?;
        drop(file);
        if hash(&draft)? != digest {
            return Err(ERROR);
        }
        fs::rename(draft, &output).map_err(|_| ERROR)?;
    }
    verify_worker_at(&output)?;
    nessie_executor_updater::storage::Store::new(root()?).save_worker_reference(&digest)?;
    Ok(output)
}
fn verify_worker_at(path: &Path) -> UpdateResult<()> {
    nessie_windows_common::update_runtime::pin_image(path, PIN)
        .map(|_| ())
        .map_err(|_| ERROR)
}
pub(in crate::updates) fn verify_worker() -> UpdateResult<()> {
    system()?;
    verify_worker_at(&std::env::current_exe().map_err(|_| ERROR)?)
}
