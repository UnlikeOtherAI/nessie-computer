//! Only a publisher-verified, notarized, readonly DMG supplies an update app.
use super::{macos_bundle::Bundle, unix_package::{command, inspect}, unix_runtime::{self, ERROR}};
use nessie_executor_updater::{catalog::UpdateResult, protocol::Manifest};
use std::{fs, path::{Path, PathBuf}, process::{Command, Stdio}};

pub(super) fn verify(image: &Path) -> UpdateResult<()> {
    crate::macos_provenance::require_current_release().map_err(|_| ERROR)?;
    let team = option_env!("NESSIE_DESKTOP_SIGNING_TEAM_ID").ok_or("update.wrong_publisher")?;
    if team.len() != 10 || !team.bytes().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit()) {
        return Err("update.wrong_publisher");
    }
    let requirement = format!("=anchor apple generic and certificate leaf[subject.OU] = \"{team}\" \
        and certificate leaf[field.1.2.840.113635.100.6.1.13] exists");
    let mut signature = command("/usr/bin/codesign");
    signature.args(["--verify", "--strict", "--test-requirement", &requirement]).arg(image);
    inspect(signature, None).map_err(|_| "update.wrong_publisher")?;
    let mut gatekeeper = command("/usr/sbin/spctl");
    gatekeeper.args(["--assess", "--type", "open", "--context", "context:primary-signature"]).arg(image);
    inspect(gatekeeper, None).map_err(|_| "update.notarization_required")?;
    Ok(())
}

struct Mount { path: PathBuf }
impl Drop for Mount {
    fn drop(&mut self) {
        // A readonly inspection mount contains no accepted work. Never force
        // unmount another process or delete a journal when detachment fails.
        let _ = Command::new("/usr/bin/hdiutil").arg("detach").arg(&self.path)
            .env_clear().stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
}

pub(super) fn stage(manifest: &Manifest, image: &Path) -> UpdateResult<Bundle> {
    unix_runtime::privileged()?;
    verify(image)?;
    let volumes = super::host::root()?.join("volumes");
    unix_runtime::directory(&volumes)?;
    let mut random = [0_u8; 16];
    unsafe { libc::arc4random_buf(random.as_mut_ptr().cast(), random.len()); }
    let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let path = volumes.join(nonce);
    unix_runtime::directory(&path)?;
    let mount = Mount { path };
    let mut attach = command("/usr/bin/hdiutil");
    attach.args(["attach", "-readonly", "-nobrowse", "-noautoopen", "-owners", "off", "-mountpoint"])
        .arg(&mount.path).arg(image);
    inspect(attach, None)?;
    let app = mount.path.join("Nessie Executor.app");
    if !fs::symlink_metadata(&app).is_ok_and(|entry| entry.is_dir() && !entry.file_type().is_symlink()) {
        return Err("update.invalid_package");
    }
    // The copier drops Root privileges. The copied seal, source and hashes are
    // checked again inside a Root-only snapshot before any privileged write.
    Bundle::candidate(&app, manifest)
}
