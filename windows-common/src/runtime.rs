//! The packaged runtime, verified before anything in it is executed.
//!
//! One producer writes this layout (`executor/scripts/prepare-runtime.mjs`) and
//! three readers verify it: the desktop shell's companion, the executor CLI, and
//! this service. The rules are theirs, restated for a host with no Node to run
//! them in: every fixed file present as an ordinary file, the manifest's
//! `nodeExecutable` one of two literals rather than a path, and the sha256 of
//! the bundle, the Node binary and the native helper matching the manifest.
//!
//! The native helper is required here, not optional as it is for the desktop.
//! The service's state root is secured and proved through that helper's
//! `secure-directory` / `verify-owner-only` commands, so a package without it
//! could not establish the DACL its whole privacy story rests on.

use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// The files present in every package, whatever the host built it.
pub const RUNTIME_FIXED_FILES: [&str; 3] =
    ["nessie-executor.cjs", "manifest.json", "NODE_LICENSE"];

/// The only two names the packaged Node binary may have. Neither is `node`, so
/// `taskkill /IM node.exe` on a loaded machine spares the executor.
const NODE_EXECUTABLES: [&str; 2] = ["nessie-executor-runtime", "nessie-executor-runtime.exe"];

/// The only two names the packaged native helper may have.
const NATIVE_HELPERS: [&str; 2] = ["nessie-executor-native", "nessie-executor-native.exe"];

const INVALID: &str = "The Nessie Executor packaged runtime is invalid.";
const UNAVAILABLE: &str = "The Nessie Executor packaged runtime is unavailable.";
const TAMPERED: &str = "The Nessie Executor packaged runtime did not pass integrity verification.";

/// Serde ignores keys it does not know, which is why `nodeExecutable` could be
/// added without moving off `format: 1`: an older reader still verifies
/// everything format 1 ever promised.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    executor_bundle_sha256: String,
    format: u8,
    native_helper: Option<String>,
    native_helper_sha256: Option<String>,
    node_executable: String,
    node_sha256: String,
}

/// A verified packaged runtime and the host-shaped file names it declared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedRuntime {
    pub native_helper: PathBuf,
    pub node_executable: PathBuf,
    pub root: PathBuf,
}

impl VerifiedRuntime {
    /// The bundle the packaged Node is asked to run.
    pub fn bundle(&self) -> PathBuf {
        self.root.join("nessie-executor.cjs")
    }
}

/// A manifest names files, never paths: only the known literals are accepted, so
/// a rewritten manifest cannot point the service at a binary of its own choosing
/// somewhere else on disk.
fn packaged_name(candidates: &[&str], declared: &str) -> Option<String> {
    candidates.iter().find(|name| **name == declared).map(|name| (*name).to_owned())
}

fn require_ordinary_file(root: &Path, name: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(root.join(name)).map_err(|_| UNAVAILABLE.to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(INVALID.to_owned());
    }
    Ok(())
}

/// Streamed, so verifying a ~100 MB Node binary never buffers it whole.
fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|_| UNAVAILABLE.to_owned())?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let read = file.read(&mut buffer).map_err(|_| UNAVAILABLE.to_owned())?;
        if read == 0 {
            return Ok(format!("{:x}", hash.finalize()));
        }
        hash.update(&buffer[..read]);
    }
}

/// The packaged runtime directory, verified for completeness and integrity.
/// Release provenance is a separate question with a separate answer
/// (`provenance.rs`): a hash manifest is a self-attestation, and this one is
/// checked because it catches a swapped file, not because it proves a publisher.
pub fn verify_packaged_runtime(root: &Path) -> Result<VerifiedRuntime, String> {
    let directory = fs::symlink_metadata(root).map_err(|_| UNAVAILABLE.to_owned())?;
    if directory.file_type().is_symlink() || !directory.is_dir() {
        return Err(INVALID.to_owned());
    }
    for name in RUNTIME_FIXED_FILES {
        require_ordinary_file(root, name)?;
    }
    let manifest: RuntimeManifest =
        serde_json::from_slice(&fs::read(root.join("manifest.json")).map_err(|_| INVALID.to_owned())?)
            .map_err(|_| INVALID.to_owned())?;
    if manifest.format != 1 {
        return Err(INVALID.to_owned());
    }
    let node_executable =
        packaged_name(&NODE_EXECUTABLES, &manifest.node_executable).ok_or(INVALID.to_owned())?;
    let (native_helper, native_helper_sha256) =
        match (&manifest.native_helper, &manifest.native_helper_sha256) {
            (Some(name), Some(digest)) => (
                packaged_name(&NATIVE_HELPERS, name).ok_or(INVALID.to_owned())?,
                digest.clone(),
            ),
            // The service secures its state root through the helper, so a
            // package without one cannot establish the DACL at all.
            _ => return Err(INVALID.to_owned()),
        };
    for name in [node_executable.as_str(), native_helper.as_str()] {
        require_ordinary_file(root, name)?;
    }
    if manifest.node_sha256 != file_sha256(&root.join(&node_executable))?
        || native_helper_sha256 != file_sha256(&root.join(&native_helper))?
        || manifest.executor_bundle_sha256 != file_sha256(&root.join("nessie-executor.cjs"))?
    {
        return Err(TAMPERED.to_owned());
    }
    Ok(VerifiedRuntime {
        native_helper: root.join(native_helper),
        node_executable: root.join(node_executable),
        root: root.to_path_buf(),
    })
}

#[cfg(test)]
mod tests {
    use super::{packaged_name, verify_packaged_runtime, INVALID, TAMPERED, NATIVE_HELPERS,
        NODE_EXECUTABLES};
    use sha2::{Digest, Sha256};
    use std::{fs, path::Path};

    fn digest(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::new().chain_update(bytes).finalize())
    }

    /// A whole runtime whose manifest matches its bytes, so each test only has
    /// to break the one thing it is about.
    fn intact_runtime(root: &Path) {
        fs::create_dir_all(root).expect("the runtime directory must be creatable");
        fs::write(root.join("nessie-executor.cjs"), b"bundle").expect("bundle");
        fs::write(root.join("nessie-executor-runtime.exe"), b"node").expect("node");
        fs::write(root.join("nessie-executor-native.exe"), b"helper").expect("helper");
        fs::write(root.join("NODE_LICENSE"), b"licence").expect("licence");
        write_manifest(
            root,
            &format!(
                r#"{{"executorBundleSha256":"{}","format":1,"nativeHelper":"nessie-executor-native.exe","nativeHelperSha256":"{}","nodeExecutable":"nessie-executor-runtime.exe","nodeSha256":"{}","nodeVersion":"22.0.0"}}"#,
                digest(b"bundle"),
                digest(b"helper"),
                digest(b"node"),
            ),
        );
    }

    fn write_manifest(root: &Path, text: &str) {
        fs::write(root.join("manifest.json"), text).expect("the manifest must be writable");
    }

    #[test]
    fn only_the_known_packaged_file_names_are_accepted() {
        let packaged = "nessie-executor-runtime.exe";
        assert_eq!(packaged_name(&NODE_EXECUTABLES, packaged).as_deref(), Some(packaged));
        // `node.exe` is the name a blanket kill matches, so it is refused too.
        for declared in [
            "",
            "node",
            "node.exe",
            "Nessie-Executor-Runtime.exe",
            "../nessie-executor-runtime",
            "C:\\Windows\\System32\\cmd.exe",
        ] {
            assert_eq!(
                packaged_name(&NODE_EXECUTABLES, declared),
                None,
                "node executable {declared:?} must be refused",
            );
        }
        assert_eq!(packaged_name(&NATIVE_HELPERS, "cmd.exe"), None);
    }

    #[test]
    fn an_intact_runtime_resolves_its_host_shaped_names() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let root = directory.path().join("runtime");
        intact_runtime(&root);
        let verified = verify_packaged_runtime(&root).expect("an intact runtime must verify");
        assert_eq!(verified.node_executable, root.join("nessie-executor-runtime.exe"));
        assert_eq!(verified.native_helper, root.join("nessie-executor-native.exe"));
        assert_eq!(verified.bundle(), root.join("nessie-executor.cjs"));
    }

    #[test]
    fn a_swapped_file_fails_the_manifest() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let root = directory.path().join("runtime");
        intact_runtime(&root);
        // The tamper the acceptance checklist performs by hand: replace the Node runtime
        // in Program Files as an administrator.
        fs::write(root.join("nessie-executor-runtime.exe"), b"another node").expect("node");
        assert_eq!(verify_packaged_runtime(&root), Err(TAMPERED.to_owned()));
    }

    #[test]
    fn a_missing_file_or_directory_is_refused_rather_than_assumed() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let root = directory.path().join("runtime");
        assert!(verify_packaged_runtime(&root).is_err());
        intact_runtime(&root);
        fs::remove_file(root.join("NODE_LICENSE")).expect("the licence must be removable");
        assert!(verify_packaged_runtime(&root).is_err());
    }

    /// The service cannot secure its state root without the helper, so a package
    /// that omits it is invalid here even though the desktop tolerates one.
    #[test]
    fn the_service_requires_a_pinned_native_helper() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let root = directory.path().join("runtime");
        intact_runtime(&root);
        write_manifest(
            &root,
            &format!(
                r#"{{"executorBundleSha256":"{}","format":1,"nodeExecutable":"nessie-executor-runtime.exe","nodeSha256":"{}","nodeVersion":"22.0.0"}}"#,
                digest(b"bundle"),
                digest(b"node"),
            ),
        );
        assert_eq!(verify_packaged_runtime(&root), Err(INVALID.to_owned()));
    }

    #[test]
    fn a_manifest_naming_a_path_or_an_unsupported_format_is_refused() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let root = directory.path().join("runtime");
        intact_runtime(&root);
        for manifest in [
            // A path where a file name belongs.
            format!(
                r#"{{"executorBundleSha256":"{}","format":1,"nativeHelper":"nessie-executor-native.exe","nativeHelperSha256":"{}","nodeExecutable":"..\\nessie-executor-runtime.exe","nodeSha256":"{}"}}"#,
                digest(b"bundle"),
                digest(b"helper"),
                digest(b"node"),
            ),
            // A format this reader never promised anything about.
            format!(
                r#"{{"executorBundleSha256":"{}","format":2,"nativeHelper":"nessie-executor-native.exe","nativeHelperSha256":"{}","nodeExecutable":"nessie-executor-runtime.exe","nodeSha256":"{}"}}"#,
                digest(b"bundle"),
                digest(b"helper"),
                digest(b"node"),
            ),
            "not json".to_owned(),
        ] {
            write_manifest(&root, &manifest);
            assert_eq!(
                verify_packaged_runtime(&root),
                Err(INVALID.to_owned()),
                "manifest {manifest:?} must be refused",
            );
        }
    }

    #[test]
    fn no_refusal_leaks_a_local_path() {
        for reason in [INVALID, TAMPERED] {
            assert!(!reason.contains('\\') && !reason.contains('/'));
        }
    }
}
