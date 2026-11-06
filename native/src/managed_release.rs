//! Linux package provenance at native child creation, not a Node self-report.
use crate::protocol::NativeError;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

pub const GUARD_VERSION: u32 = 2;
pub fn refused() -> NativeError {
    NativeError::new("EXECUTOR_MANAGED_RELEASE_REJECTED")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: u32,
    managed_launch_protocol: u32,
    personal_inference_guard_version: u32,
    node_executable: String,
    node_sha256: String,
    executor_bundle_sha256: String,
    native_helper: String,
    native_helper_sha256: String,
    resources_manifest_sha256: String,
    executor_version: Option<String>,
    executor_source_commit: Option<String>,
}

pub struct Release {
    pub directory: PathBuf,
    pub digest: String,
    pub node: File,
    pub node_digest: String,
    pub version: Option<String>,
    pub source_commit: Option<String>,
    // Opened immutable release files remain tied to the verified inodes. The
    // native parent retains them for the child's lifetime.
    pub handles: Vec<File>,
}

fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn immutable(path: &Path, directory: bool) -> Result<File, NativeError> {
    let entry = fs::symlink_metadata(path).map_err(|_| refused())?;
    if entry.uid() != 0
        || entry.mode() & 0o222 != 0
        || entry.file_type().is_symlink()
        || (directory && !entry.is_dir())
        || (!directory && (!entry.is_file() || entry.nlink() != 1))
    {
        return Err(refused());
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| refused())?;
    let opened = file.metadata().map_err(|_| refused())?;
    if entry.dev() != opened.dev() || entry.ino() != opened.ino() {
        return Err(refused());
    }
    Ok(file)
}

fn bytes(file: &File, maximum: u64) -> Result<Vec<u8>, NativeError> {
    if file.metadata().map_err(|_| refused())?.len() > maximum {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    file.try_clone()
        .map_err(|_| refused())?
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    if bytes.len() as u64 > maximum {
        return Err(refused());
    }
    Ok(bytes)
}

fn digest_file(file: &File) -> Result<String, NativeError> {
    let mut hasher = Sha256::new();
    let mut reader = file.try_clone().map_err(|_| refused())?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer).map_err(|_| refused())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn collect(directory: &Path, files: &mut Vec<File>) -> Result<(), NativeError> {
    files.push(immutable(directory, true)?);
    for entry in fs::read_dir(directory).map_err(|_| refused())? {
        let path = entry.map_err(|_| refused())?.path();
        let kind = fs::symlink_metadata(&path).map_err(|_| refused())?;
        if kind.is_dir() {
            collect(&path, files)?;
        } else {
            files.push(immutable(&path, false)?);
        }
        if files.len() > 4096 {
            return Err(refused());
        }
    }
    Ok(())
}

pub fn load() -> Result<Release, NativeError> {
    #[cfg(target_os = "linux")]
    let executable = fs::read_link("/proc/self/exe").map_err(|_| refused())?;
    #[cfg(target_os = "macos")]
    let executable = {
        crate::macos_provenance::require_current_release()?;
        std::env::current_exe().map_err(|_| refused())?
    };
    let release = load_image(executable, true)?;
    // A retired native creator must not launch its old Node after an update.
    // Existing accepted updater workers use installed(), rather than creating
    // a managed runtime from their own surviving immutable image.
    require_selected(&release)?;
    Ok(release)
}

/// Repeat under the machine admission lock immediately before native creation.
pub fn require_selected(release: &Release) -> Result<(), NativeError> {
    if installed()?.digest != release.digest { return Err(refused()); }
    Ok(())
}

/// The installed pointer may advance while an immutable updater worker finishes
/// its accepted transaction. Read that release with the same provenance checks.
pub fn installed() -> Result<Release, NativeError> {
    #[cfg(target_os = "linux")]
    let current = Path::new("/usr/lib/nessie-executor/current");
    #[cfg(target_os = "macos")]
    let current = Path::new("/Library/Application Support/Nessie Executor/current");
    let pointer = fs::symlink_metadata(current).map_err(|_| refused())?;
    if !pointer.file_type().is_symlink() || pointer.uid() != 0 { return Err(refused()); }
    let executable = fs::canonicalize(current.join("nessie-executor-native")).map_err(|_| refused())?;
    load_image(executable, false)
}

fn trusted_ancestors(directory: &Path) -> Result<(), NativeError> {
    let mut ancestor = Some(directory);
    while let Some(path) = ancestor {
        let entry = fs::symlink_metadata(path).map_err(|_| refused())?;
        if !entry.is_dir() || entry.file_type().is_symlink() || entry.uid() != 0 || entry.mode() & 0o022 != 0 {
            return Err(refused());
        }
        ancestor = path.parent();
    }
    Ok(())
}

/// Privileged bundle installation verifies copied, readonly contents before
/// selecting them. This accepts only its fixed protected staging namespace;
/// ordinary creators still require the selected immutable release below.
#[cfg(target_os = "macos")]
pub(crate) fn load_staged(directory: &Path, expected_digest: &str) -> Result<Release, NativeError> {
    let root = Path::new("/Library/Application Support/Nessie Executor/releases");
    if unsafe { libc::getuid() } != 0 || unsafe { libc::geteuid() } != 0
        || directory.parent() != Some(root) || expected_digest.len() != 64
        || !expected_digest.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err(refused()); }
    let prefix = format!(".staged-{expected_digest}-");
    let nonce = directory.file_name().and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix(&prefix)).ok_or_else(refused)?;
    if nonce.len() != 32 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err(refused()); }
    trusted_ancestors(root)?;
    let release = load_contents(directory.to_path_buf(), None)?;
    if release.digest != expected_digest { return Err(refused()); }
    Ok(release)
}

/// Root installation can reuse an already verified immutable candidate. This
/// never changes selection or grants an old creator admission to launch Node.
#[cfg(target_os = "macos")]
pub(crate) fn retained(digest: &str) -> Result<Release, NativeError> {
    if unsafe { libc::getuid() } != 0 || unsafe { libc::geteuid() } != 0
        || digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err(refused()); }
    load_image(Path::new("/Library/Application Support/Nessie Executor/releases").join(digest)
        .join("nessie-executor-native"), false)
}

fn load_image(executable: PathBuf, current: bool) -> Result<Release, NativeError> {
    let directory = executable.parent().ok_or_else(refused)?.to_path_buf();
    #[cfg(target_os = "linux")]
    let releases = Path::new("/usr/lib/nessie-executor/releases");
    #[cfg(target_os = "macos")]
    let releases = Path::new("/Library/Application Support/Nessie Executor/releases");
    if directory.parent() != Some(releases)
        || !matches!(executable.file_name().and_then(|name| name.to_str()),
            Some("nessie-executor-native" | "nessie-computer-updater"))
    {
        return Err(refused());
    }
    // Ancestors are trusted package directories; release contents are readonly.
    trusted_ancestors(releases)?;
    let release = load_contents(directory, current.then_some(executable.as_path()))?;
    if release.directory.file_name().and_then(|name| name.to_str()) != Some(release.digest.as_str()) {
        return Err(refused());
    }
    Ok(release)
}

fn load_contents(directory: PathBuf, current_image: Option<&Path>) -> Result<Release, NativeError> {
    let mut handles = Vec::new();
    collect(&directory, &mut handles)?;
    let manifest_file = immutable(&directory.join("manifest.json"), false)?;
    let manifest_bytes = bytes(&manifest_file, 64 * 1024)?;
    let digest = hex_digest(&manifest_bytes);
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes).map_err(|_| refused())?;
    if manifest.format != 1
        || manifest.managed_launch_protocol != 1
        || manifest.personal_inference_guard_version != GUARD_VERSION
        || manifest.node_executable != "nessie-executor-runtime"
        || manifest.native_helper != "nessie-executor-native"
    {
        return Err(refused());
    }
    let node = immutable(&directory.join(&manifest.node_executable), false)?;
    for (path, expected) in [
        ("nessie-executor-runtime", &manifest.node_sha256),
        ("nessie-executor.cjs", &manifest.executor_bundle_sha256),
        ("nessie-executor-native", &manifest.native_helper_sha256),
        (
            "resources/manifest.json",
            &manifest.resources_manifest_sha256,
        ),
    ] {
        if digest_file(&immutable(&directory.join(path), false)?)? != *expected {
            return Err(refused());
        }
    }
    // The kernel's loaded native image, not merely the matching current path.
    #[cfg(target_os = "linux")]
    if current_image.is_some() && digest_file(&File::open("/proc/self/exe").map_err(|_| refused())?)?
        != manifest.native_helper_sha256
    {
        return Err(refused());
    }
    #[cfg(target_os = "macos")]
    if let Some(executable) = current_image {
        if digest_file(&immutable(executable, false)?)? != manifest.native_helper_sha256 { return Err(refused()); }
    }
    #[cfg(target_os = "macos")]
    for name in ["nessie-executor-native", "nessie-executor-runtime"] {
        crate::macos_provenance::require_file(&directory.join(name))?;
    }
    handles.push(manifest_file);
    Ok(Release {
        directory,
        digest,
        node,
        node_digest: manifest.node_sha256,
        version: manifest.executor_version,
        source_commit: manifest.executor_source_commit,
        handles,
    })
}

fn allowed_environment(name: &std::ffi::OsStr) -> bool {
    let key = name.to_string_lossy();
    !key.starts_with("NODE_")
        && !key.starts_with("LD_")
        && !key.starts_with("DYLD_")
        && !key.starts_with("NESSIE_TEST_")
        && !key.starts_with("NESSIE_EXECUTOR_NATIVE_")
        && !key.starts_with("NESSIE_MANAGED_")
        && key != "NESSIE_EXECUTOR_PACKAGED_CLI"
        && key != "HOME"
        && ![
            "GCONV_PATH",
            "LOCPATH",
            "GLIBC_TUNABLES",
            "OPENSSL_CONF",
            "OPENSSL_MODULES",
        ]
        .contains(&key.as_ref())
}

pub fn environment(home: &Path) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    std::env::vars_os()
        .filter(|(name, _)| allowed_environment(name))
        .chain([
            (
                std::ffi::OsString::from("NESSIE_EXECUTOR_PACKAGED_CLI"),
                std::ffi::OsString::from("1"),
            ),
            (
                std::ffi::OsString::from("HOME"),
                home.as_os_str().to_owned(),
            ),
        ])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn loader_and_helper_overrides_never_reach_managed_node() {
        for key in [
            "NODE_OPTIONS",
            "NODE_PATH",
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
            "DYLD_INSERT_LIBRARIES",
            "NESSIE_EXECUTOR_NATIVE_HELPER_PATH",
            "NESSIE_TEST_NATIVE_SECURITY_HELPER",
            "HOME",
            "GCONV_PATH",
            "LOCPATH",
            "GLIBC_TUNABLES",
            "OPENSSL_CONF",
            "OPENSSL_MODULES",
        ] {
            assert!(!allowed_environment(std::ffi::OsStr::new(key)), "{key}");
        }
        assert!(allowed_environment(std::ffi::OsStr::new("PATH")));
    }

    #[test]
    fn mutable_or_symlinked_available_bytes_are_not_a_release() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("runtime");
        fs::write(&file, b"not executable provenance").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(immutable(&file, false).is_err());
        std::os::unix::fs::symlink(&file, directory.path().join("linked")).unwrap();
        assert!(immutable(&directory.path().join("linked"), false).is_err());
        assert!(
            load().is_err(),
            "a test binary is never an installed immutable release"
        );
    }
}
