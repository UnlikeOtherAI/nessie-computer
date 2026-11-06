//! A sealed application supplies the first immutable factory, never caller code.
use super::{admission_unix, unix_runtime::{self, ERROR}};
use nessie_executor_updater::catalog::UpdateResult;
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, os::unix::fs::{DirBuilderExt,
    MetadataExt, OpenOptionsExt, PermissionsExt}, path::{Path, PathBuf}};

pub(super) const APPLICATIONS: [&str; 3] = ["/Applications/Nessie Executor.app",
    "/Applications/Nessie.app/Contents/Library/LoginItems/Nessie Executor.app",
    "/Applications/Nessie Desktop.app/Contents/Library/LoginItems/Nessie Executor.app"];
const RELEASES: &str = "/Library/Application Support/Nessie Executor/releases";

pub(super) struct Bundle {
    app: PathBuf,
    runtime: PathBuf,
    digest: String,
    version: String,
    source: String,
}

impl Bundle {
    pub(super) fn candidate(app: &Path, manifest: &nessie_executor_updater::protocol::Manifest) -> UpdateResult<Self> {
        let key = format!("{:x}", Sha256::digest(serde_json::to_vec(manifest).map_err(|_| ERROR)?));
        let snapshot = super::macos_snapshot::capture(app, &key)?;
        let value = Self::open(&snapshot)?;
        if value.version != manifest.version || value.source != manifest.source_commit { return Err(ERROR); }
        Ok(value)
    }

    /// An exchange keeps a registered BundleProgram present across power loss.
    /// The prior app is retained inside the private snapshot container.
    pub(super) fn replace_application(&self) -> UpdateResult<()> {
        unix_runtime::privileged()?;
        let applications = Path::new("/Applications");
        let parent = fs::symlink_metadata(applications).map_err(|_| ERROR)?;
        // macOS permits the local admin group to install apps here. Root's
        // source is still its immutable private snapshot, never that directory.
        if !parent.is_dir() || parent.file_type().is_symlink() || parent.uid() != 0 || parent.mode() & 0o002 != 0 {
            return Err(ERROR);
        }
        let target = applications.join("Nessie Executor.app");
        let prepared = super::macos_snapshot::clone_verified(&self.app)?;
        let source = std::ffi::CString::new(prepared.as_os_str().as_encoded_bytes()).map_err(|_| ERROR)?;
        let destination = std::ffi::CString::new(target.as_os_str().as_encoded_bytes()).map_err(|_| ERROR)?;
        match fs::symlink_metadata(&target) {
            Ok(entry) if entry.is_dir() && !entry.file_type().is_symlink() => {
                // RENAME_SWAP is atomic, including the app's registered service.
                if unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_SWAP) } != 0 {
                    return Err("update.application_replace_failed");
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::rename(&prepared, &target).map_err(|_| "update.application_replace_failed")?;
            },
            _ => return Err("update.application_replace_failed"),
        }
        File::open(applications).and_then(|file| file.sync_all()).map_err(|_| ERROR)?;
        File::open(prepared.parent().ok_or(ERROR)?).and_then(|file| file.sync_all()).map_err(|_| ERROR)?;
        crate::macos_provenance::require_updater_app(&target).map_err(|_| ERROR)
    }

    /// SMAppService executes this fixed bundled native image as Root only after
    /// administrator approval. No path or source claim arrives over IPC.
    pub(super) fn authorize_registered() -> UpdateResult<PathBuf> {
        unix_runtime::privileged()?;
        crate::macos_provenance::require_current_release().map_err(|_| ERROR)?;
        let executable = std::env::current_exe().map_err(|_| ERROR)?;
        let app = executable.ancestors().nth(4).ok_or(ERROR)?;
        if !APPLICATIONS.iter().any(|allowed| app == Path::new(allowed))
            || executable != app.join("Contents/Resources/executor-runtime/nessie-executor-native") {
            return Err(ERROR);
        }
        crate::macos_provenance::require_updater_app(app).map_err(|_| ERROR)?;
        Ok(app.to_path_buf())
    }

    pub(super) fn registered() -> UpdateResult<Self> {
        let app = Self::authorize_registered()?;
        let executable = std::env::current_exe().map_err(|_| ERROR)?;
        // Validate the copied seal, rather than trusting a manifest read from
        // a user-writable app between two independent signature checks.
        let snapshot = super::macos_snapshot::capture(&app, &unix_runtime::hash(&executable)?)?;
        let value = Self::open(&snapshot)?;
        if value.source != env!("NESSIE_EXECUTOR_SOURCE_COMMIT") || value.version != env!("NESSIE_EXECUTOR_VERSION") {
            return Err(ERROR);
        }
        let bytes = fs::read(value.runtime.join("manifest.json")).map_err(|_| ERROR)?;
        let manifest: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
        if manifest["nativeHelperSha256"] != unix_runtime::hash(&executable)? { return Err(ERROR); }
        Ok(value)
    }

    fn open(app: &Path) -> UpdateResult<Self> {
        crate::macos_provenance::require_updater_app(app).map_err(|_| ERROR)?;
        let runtime = app.join("Contents/Resources/executor-runtime");
        let bytes = fs::read(runtime.join("manifest.json")).map_err(|_| ERROR)?;
        if bytes.len() > 65_536 { return Err(ERROR); }
        let manifest: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
        if manifest["format"] != 1 || manifest["managedLaunchProtocol"] != 1
            || manifest["personalInferenceGuardVersion"] != 2 || manifest["updateAdmissionProtocol"] != 1
            || manifest["nodeExecutable"] != "nessie-executor-runtime" || manifest["nativeHelper"] != "nessie-executor-native" {
            return Err(ERROR);
        }
        let version = manifest["executorVersion"].as_str().ok_or(ERROR)?.to_owned();
        let source = manifest["executorSourceCommit"].as_str().ok_or(ERROR)?.to_owned();
        nessie_executor_updater::catalog::compare_versions(&version, &version)?;
        if source.len() != 40 || !source.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err(ERROR); }
        for (name, key) in [("nessie-executor-native", "nativeHelperSha256"),
            ("nessie-executor-runtime", "nodeSha256"), ("nessie-executor.cjs", "executorBundleSha256"),
            ("resources/manifest.json", "resourcesManifestSha256")] {
            if manifest[key] != unix_runtime::hash(&runtime.join(name))? { return Err(ERROR); }
        }
        crate::macos_provenance::require_updater_app(app).map_err(|_| ERROR)?;
        Ok(Self { app: app.to_path_buf(), runtime, digest: format!("{:x}", Sha256::digest(bytes)), version, source })
    }

    pub(super) fn install_factory(&self) -> UpdateResult<String> {
        unix_runtime::privileged()?;
        let root = Path::new(RELEASES);
        unix_runtime::directory(root)?;
        let released = root.join(&self.digest);
        if released.try_exists().map_err(|_| ERROR)? {
            let release = crate::managed_release::retained(&self.digest).map_err(|_| ERROR)?;
            if release.version.as_deref() != Some(&self.version) || release.source_commit.as_deref() != Some(&self.source) {
                return Err(ERROR);
            }
            return Ok(self.digest.clone());
        }
        // Reserve both the copied runtime and room for recovery before touching
        // staging. An incomplete copy is retained; it is never selected.
        let mut budget = Budget::default();
        measure(&self.runtime, &mut budget, 0)?;
        let path = std::ffi::CString::new(RELEASES).map_err(|_| ERROR)?;
        let mut space: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(path.as_ptr(), &mut space) } != 0
            || (space.f_bavail as u64).saturating_mul(space.f_frsize as u64) < budget.bytes.saturating_add(1_073_741_824) {
            return Err("update.insufficient_space");
        }
        let mut random = [0_u8; 16];
        unsafe { libc::arc4random_buf(random.as_mut_ptr().cast(), random.len()); }
        let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let staged = root.join(format!(".staged-{}-{nonce}", self.digest));
        copy(&self.runtime, &staged, 0)?;
        crate::macos_provenance::require_updater_app(&self.app).map_err(|_| ERROR)?;
        let release = crate::managed_release::load_staged(&staged, &self.digest).map_err(|_| ERROR)?;
        if release.version.as_deref() != Some(&self.version) || release.source_commit.as_deref() != Some(&self.source) {
            return Err(ERROR);
        }
        fs::rename(staged, released).map_err(|_| ERROR)?;
        File::open(root).and_then(|file| file.sync_all()).map_err(|_| ERROR)?;
        Ok(self.digest.clone())
    }
}

#[derive(Default)]
struct Budget { nodes: u32, bytes: u64 }
fn measure(path: &Path, budget: &mut Budget, depth: u32) -> UpdateResult<()> {
    let entry = fs::symlink_metadata(path).map_err(|_| ERROR)?;
    budget.nodes += 1;
    if depth > 32 || budget.nodes > 4096 || entry.file_type().is_symlink() { return Err(ERROR); }
    if entry.is_dir() {
        for child in fs::read_dir(path).map_err(|_| ERROR)? {
            measure(&child.map_err(|_| ERROR)?.path(), budget, depth + 1)?;
        }
    } else if entry.is_file() && entry.nlink() == 1 && entry.len() <= 268_435_456 {
        budget.bytes = budget.bytes.checked_add(entry.len()).ok_or(ERROR)?;
        if budget.bytes > 1_073_741_824 { return Err(ERROR); }
    } else { return Err(ERROR); }
    Ok(())
}

fn copy(source: &Path, target: &Path, depth: u32) -> UpdateResult<()> {
    if depth > 32 { return Err(ERROR); }
    let entry = fs::symlink_metadata(source).map_err(|_| ERROR)?;
    if entry.file_type().is_symlink() { return Err(ERROR); }
    if entry.is_dir() {
        fs::DirBuilder::new().mode(0o700).create(target).map_err(|_| ERROR)?;
        for child in fs::read_dir(source).map_err(|_| ERROR)? {
            let child = child.map_err(|_| ERROR)?;
            copy(&child.path(), &target.join(child.file_name()), depth + 1)?;
        }
        fs::set_permissions(target, fs::Permissions::from_mode(0o555)).map_err(|_| ERROR)?;
        File::open(target).and_then(|file| file.sync_all()).map_err(|_| ERROR)?;
    } else {
        if !entry.is_file() || entry.nlink() != 1 || entry.len() > 268_435_456 { return Err(ERROR); }
        let mut input = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(source).map_err(|_| ERROR)?;
        let opened = input.metadata().map_err(|_| ERROR)?;
        if opened.dev() != entry.dev() || opened.ino() != entry.ino() { return Err(ERROR); }
        let mut output = OpenOptions::new().write(true).create_new(true).mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(target).map_err(|_| ERROR)?;
        let count = std::io::copy(&mut Read::by_ref(&mut input).take(entry.len() + 1), &mut output).map_err(|_| ERROR)?;
        if count != entry.len() { return Err(ERROR); }
        let mode = if entry.mode() & 0o111 != 0 { 0o555 } else { 0o444 };
        output.set_permissions(fs::Permissions::from_mode(mode)).map_err(|_| ERROR)?;
        output.flush().and_then(|()| output.sync_all()).map_err(|_| ERROR)?;
    }
    Ok(())
}

/// The caller retains the persistent machine barrier and has independently
/// cleared old actors. Replacing this link never replaces a custody inode.
pub(super) fn select(digest: &str) -> UpdateResult<()> {
    unix_runtime::privileged()?;
    crate::managed_release::retained(digest).map_err(|_| ERROR)?;
    let root = Path::new(RELEASES).parent().ok_or(ERROR)?;
    admission_unix::directory(root)?;
    let mut random = [0_u8; 16];
    unsafe { libc::arc4random_buf(random.as_mut_ptr().cast(), random.len()); }
    let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let draft = root.join(format!(".current-{nonce}"));
    std::os::unix::fs::symlink(Path::new("releases").join(digest), &draft).map_err(|_| ERROR)?;
    fs::rename(draft, root.join("current")).map_err(|_| ERROR)?;
    File::open(root).and_then(|file| file.sync_all()).map_err(|_| ERROR)
}
