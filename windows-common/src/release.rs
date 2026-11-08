//! Pins an administrator-owned release namespace and all executable inputs.
use crate::{
    custody::REJECTED,
    runtime::{verify_packaged_runtime, VerifiedRuntime},
};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Component, Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::{LocalFree, HANDLE},
    Security::{
        Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
        GetAce, ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION, INHERIT_ONLY_ACE, OWNER_SECURITY_INFORMATION,
    },
    Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ, FILE_SHARE_WRITE, READ_CONTROL,
    },
};

pub struct Release {
    pub runtime: VerifiedRuntime,
    pub digest: String,
    pub version: Option<String>,
    pub source_commit: Option<String>,
    pub launch_consumers: Option<LaunchConsumers>,
    _pins: Vec<File>,
}
impl Release {
    /// A coherent installed package includes the signed launch consumers,
    /// not only its native helper and JavaScript payload.
    pub fn verify_launch_consumers(&mut self, pin_eku: Option<&str>) -> Result<(), String> {
        let consumers = self.launch_consumers.as_ref().ok_or(REJECTED)?;
        for (name, expected) in [("nessie-executor-service.exe", &consumers.service_sha256),
            ("nessie-executor-tray.exe", &consumers.tray_sha256)] {
            let file = pin_launcher(&self.runtime.root.join(name), pin_eku)?;
            verify_launcher_digest(&file, expected)?;
            self._pins.push(file);
        }
        Ok(())
    }
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchConsumers {
    protocol_version: u32,
    pub service_sha256: String,
    pub tray_sha256: String,
}
fn launch_consumers(manifest: &serde_json::Value) -> Result<Option<LaunchConsumers>, String> {
    let Some(value) = manifest.get("windowsLaunchConsumers") else {
        return Ok(None);
    };
    let consumers: LaunchConsumers = serde_json::from_value(value.clone()).map_err(|_| REJECTED)?;
    if consumers.protocol_version != crate::custody::VERSION
        || !crate::custody::valid_nonce(&consumers.service_sha256)
        || !crate::custody::valid_nonce(&consumers.tray_sha256)
    {
        return Err(REJECTED.into());
    }
    Ok(Some(consumers))
}
fn trusted(sid: &str) -> bool {
    // SYSTEM, Administrators, and TrustedInstaller. No interactive account can
    // own or rewrite a personal-eligible release. Administrators remain the
    // stated OS trust boundary, never a credential-authority substitute.
    matches!(sid, "S-1-5-18" | "S-1-5-32-544")
        || crate::service_channel::account_sid(r"NT SERVICE\TrustedInstaller")
            .is_ok_and(|trusted| trusted == sid)
}
fn secure(handle: HANDLE) -> Result<(), String> {
    let mut owner = std::ptr::null_mut();
    let mut acl: *mut ACL = std::ptr::null_mut();
    let mut descriptor = std::ptr::null_mut();
    if unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut acl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    } != 0
        || descriptor.is_null()
    {
        return Err(REJECTED.into());
    }
    let result = (|| {
        if !crate::sid_to_string(owner).as_deref().is_some_and(trusted) || acl.is_null() {
            return Err(REJECTED.into());
        }
        let writes = 0x4000_0000_u32
            | 0x1000_0000
            | 0x0001_0000
            | 0x0004_0000
            | 0x0008_0000
            | 0x0000_0002
            | 0x0000_0004
            | 0x0000_0010
            | 0x0000_0040
            | 0x0000_0100;
        for index in 0..unsafe { (*acl).AceCount } as u32 {
            let mut pointer = std::ptr::null_mut();
            if unsafe { GetAce(acl, index, &mut pointer) } == 0 || pointer.is_null() {
                return Err(REJECTED.into());
            }
            let ace = unsafe { &*pointer.cast::<ACCESS_ALLOWED_ACE>() };
            if ace.Header.AceType == 1 {
                continue;
            } // Deny ACE never grants write access.
            if ace.Header.AceType != 0 {
                return Err(REJECTED.into());
            }
            // Inherit-only entries grant no access to this object. Every
            // executable input is pinned separately with its effective DACL.
            if u32::from(ace.Header.AceFlags) & INHERIT_ONLY_ACE != 0 {
                continue;
            }
            if ace.Mask & writes != 0 {
                let sid = crate::sid_to_string((&ace.SidStart as *const u32).cast_mut().cast())
                    .ok_or(REJECTED)?;
                if !trusted(&sid) {
                    return Err(REJECTED.into());
                }
            }
        }
        Ok(())
    })();
    unsafe { LocalFree(descriptor) };
    result
}
fn pin(path: &Path, directory: bool, protected: bool) -> Result<File, String> {
    let mut options = OpenOptions::new();
    if directory {
        options
            .access_mode(FILE_READ_ATTRIBUTES | if protected { READ_CONTROL } else { 0 })
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
    } else {
        options.read(true).share_mode(FILE_SHARE_READ);
    }
    let file = options
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(|_| REJECTED)?;
    let entry = file.metadata().map_err(|_| REJECTED)?;
    if entry.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || entry.is_dir() != directory
        || (!directory && !entry.is_file())
    {
        return Err(REJECTED.into());
    }
    if !directory {
        let mut facts: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &mut facts) } == 0
            || facts.nNumberOfLinks != 1
        {
            return Err(REJECTED.into());
        }
    }
    if protected {
        secure(file.as_raw_handle() as HANDLE)?;
    }
    Ok(file)
}

/// Retain a root-owned updater path with the same reparse, owner and DACL
/// checks used for installed releases. Public read access grants no writes.
pub fn pin_protected(path: &Path, directory: bool) -> Result<File, String> {
    pin(path, directory, true)
}
pub(crate) fn pin_launcher(path: &Path, pin_eku: Option<&str>) -> Result<File, String> {
    let file = pin(path, false, true)?;
    nessie_windows_provenance::decide_release_signature(
        pin_eku,
        nessie_windows_provenance::collect_signature_facts(path),
    )?;
    Ok(file)
}
pub(crate) fn verify_launcher_digest(file: &File, expected: &str) -> Result<(), String> {
    if file.metadata().map_err(|_| REJECTED)?.len() > 256 * 1024 * 1024 {
        return Err(REJECTED.into());
    }
    let mut input = file.try_clone().map_err(|_| REJECTED)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let size = input.read(&mut buffer).map_err(|_| REJECTED)?;
        if size == 0 {
            break;
        }
        digest.update(&buffer[..size]);
    }
    if format!("{:x}", digest.finalize()) != expected {
        return Err(REJECTED.into());
    }
    Ok(())
}
pub fn load(pin_eku: Option<&str>) -> Result<Release, String> {
    let executable = std::env::current_exe().map_err(|_| REJECTED)?;
    load_at(&executable, pin_eku)
}
pub fn load_at(executable: &Path, pin_eku: Option<&str>) -> Result<Release, String> {
    let root = executable.parent().ok_or(REJECTED)?;
    if !root.is_absolute() {
        return Err(REJECTED.into());
    }
    let mut pins = Vec::new();
    let mut path = PathBuf::new();
    for part in root.components() {
        match part {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                path.push(part.as_os_str())
            }
            _ => return Err(REJECTED.into()),
        }
        if path.has_root() {
            pins.push(pin(&path, true, path == root)?);
        }
    }
    for name in [
        "manifest.json",
        "nessie-executor.cjs",
        "nessie-executor-runtime.exe",
        "nessie-executor-native.exe",
        "NODE_LICENSE",
    ] {
        pins.push(pin(&root.join(name), false, true)?);
    }
    let runtime = verify_packaged_runtime(root)?;
    nessie_windows_provenance::decide_release_signature(
        pin_eku,
        nessie_windows_provenance::collect_signature_facts(&runtime.native_helper),
    )?;
    // Node's upstream signature is not the Nessie publisher. Its exact bytes
    // and the compiled bundle are retained and bound by the secured manifest.
    let mut manifest = File::open(root.join("manifest.json")).map_err(|_| REJECTED)?;
    let mut bytes = Vec::new();
    manifest
        .by_ref()
        .take(65_537)
        .read_to_end(&mut bytes)
        .map_err(|_| REJECTED)?;
    if bytes.len() > 65_536 {
        return Err(REJECTED.into());
    }
    let manifest: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| REJECTED)?;
    if manifest["managedRuntimeGuardVersion"] != crate::custody::VERSION {
        return Err(REJECTED.into());
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let launch_consumers = launch_consumers(&manifest)?;
    Ok(Release {
        runtime,
        digest,
        version: manifest.get("executorVersion").and_then(|value| value.as_str()).map(str::to_owned),
        source_commit: manifest.get("executorSourceCommit").and_then(|value| value.as_str()).map(str::to_owned),
        launch_consumers,
        _pins: pins,
    })
}

#[cfg(test)]
#[path = "release_directory_tests.rs"]
mod directory_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_user_writable_self_attested_runtime_never_becomes_a_trusted_release() {
        let root = tempfile::tempdir().unwrap();
        assert!(load_at(&root.path().join("nessie-executor-native.exe"), None).is_err());
    }
    #[test]
    fn consumer_protocol_is_closed_and_old_signed_bytes_do_not_match_the_selected_release() {
        assert!(launch_consumers(&serde_json::json!({})).unwrap().is_none());
        for value in [
            serde_json::json!({"protocolVersion":1,"serviceSha256":"a".repeat(64),
            "traySha256":"b".repeat(64)}),
            serde_json::json!({"protocolVersion":2,"serviceSha256":"invalid",
            "traySha256":"b".repeat(64)}),
        ] {
            assert!(
                launch_consumers(&serde_json::json!({"windowsLaunchConsumers":value})).is_err()
            );
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("launcher.exe");
        std::fs::write(&path, b"older signed launcher fixture").unwrap();
        let file = File::open(&path).unwrap();
        assert!(verify_launcher_digest(
            &file,
            &format!("{:x}", Sha256::digest(b"current launcher"))
        )
        .is_err());
        let file = File::open(&path).unwrap();
        assert!(verify_launcher_digest(
            &file,
            &format!("{:x}", Sha256::digest(b"older signed launcher fixture"))
        )
        .is_ok());
    }
}
