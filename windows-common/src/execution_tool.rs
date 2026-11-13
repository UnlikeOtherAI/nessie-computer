//! Consume only a root-installed tool record in the already verified release.
//! Installation verifies vendor signature/version; callers cannot enroll an image.
use crate::{
    custody::{valid_nonce, REJECTED},
    execution::{identifier, value_digest},
    release::{pin_protected, Release},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::{Path, PathBuf},
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFinalPathNameByHandleW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, READ_CONTROL, VOLUME_NAME_GUID,
};
pub const PUBLISHER: &str = "CN=Agilebits, O=Agilebits, L=Toronto, S=Ontario, C=CA";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub version: String,
    pub sha256: String,
    pub publisher_subject: String,
}
pub struct HeldTool {
    pub record: Record,
    pub installation_digest: String,
    pub image: PathBuf,
    pub directory: PathBuf,
    release_digest: String,
    manifest: File,
    image_file: File,
    _pins: Vec<File>,
}
fn final_path(file: &File) -> Result<PathBuf, String> {
    let mut bytes = vec![0u16; 32768];
    let count = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            VOLUME_NAME_GUID,
        )
    };
    if count == 0 || count as usize >= bytes.len() {
        return Err(REJECTED.into());
    }
    let path = String::from_utf16(&bytes[..count as usize]).map_err(|_| REJECTED)?;
    if !path.starts_with(r"\\?\Volume{") {
        return Err(REJECTED.into());
    }
    Ok(path.into())
}
fn namespace(path: &Path) -> Result<(File, File), String> {
    let security = pin_protected(path, true)?;
    // Metadata-only handles do not enforce directory sharing. LIST_DIRECTORY
    // supplies the no-write/no-delete namespace pin without enumerating files.
    let held = OpenOptions::new()
        .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| REJECTED)?;
    if final_path(&held)? != final_path(&security)? {
        return Err(REJECTED.into());
    }
    Ok((held, security))
}
fn digest_file(file: &mut File, limit: u64) -> Result<String, String> {
    if file.metadata().map_err(|_| REJECTED)?.len() > limit {
        return Err(REJECTED.into());
    }
    file.seek(SeekFrom::Start(0)).map_err(|_| REJECTED)?;
    let mut hash = Sha256::new();
    let mut bytes = [0u8; 65536];
    loop {
        let count = file.read(&mut bytes).map_err(|_| REJECTED)?;
        if count == 0 {
            break;
        }
        hash.update(&bytes[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
impl HeldTool {
    pub fn open(release: &Release) -> Result<Self, String> {
        let mut pins = Vec::new();
        let mut directory = release.runtime.root.clone();
        for suffix in [None, Some("tools"), Some("onepassword")] {
            if let Some(suffix) = suffix {
                directory.push(suffix);
            }
            let (held, security) = namespace(&directory)?;
            directory = final_path(&held)?;
            pins.extend([held, security]);
        }
        let mut manifest = pin_protected(&release.runtime.root.join("manifest.json"), false)?;
        if digest_file(&mut manifest, 65536)? != release.digest {
            return Err(REJECTED.into());
        }
        manifest.seek(SeekFrom::Start(0)).map_err(|_| REJECTED)?;
        let mut bytes = Vec::new();
        manifest
            .by_ref()
            .take(65537)
            .read_to_end(&mut bytes)
            .map_err(|_| REJECTED)?;
        let value = crate::execution_json::parse(&bytes)?;
        let record: Record = serde_json::from_value(value["executionTools"]["onePassword"].clone())
            .map_err(|_| REJECTED)?;
        if !identifier(&record.version)
            || record.version.len() > 128
            || !valid_nonce(&record.sha256)
            || record.publisher_subject != PUBLISHER
        {
            return Err(REJECTED.into());
        }
        let installation_digest = value_digest(
            &serde_json::json!({"releaseDigest":release.digest,"onePassword":record}),
        )?;
        let mut image_file = pin_protected(&directory.join("op.exe"), false)?;
        if digest_file(&mut image_file, 256 * 1024 * 1024)? != record.sha256 {
            return Err(REJECTED.into());
        }
        let image = final_path(&image_file)?;
        if image.parent() != Some(directory.as_path())
            || image.file_name().and_then(|s| s.to_str()) != Some("op.exe")
        {
            return Err(REJECTED.into());
        }
        Ok(Self {
            record,
            installation_digest,
            image,
            directory,
            release_digest: release.digest.clone(),
            manifest,
            image_file,
            _pins: pins,
        })
    }
    pub fn recheck(&mut self) -> Result<(), String> {
        if digest_file(&mut self.manifest, 65536)? != self.release_digest
            || digest_file(&mut self.image_file, 256 * 1024 * 1024)? != self.record.sha256
            || final_path(&self.image_file)? != self.image
        {
            return Err(REJECTED.into());
        }
        // Recheck current ACLs on canonical, namespace-pinned objects.
        for file in &self._pins {
            let _current = pin_protected(&final_path(file)?, true)?;
        }
        let _current = pin_protected(&self.image, false)?;
        Ok(())
    }
}
