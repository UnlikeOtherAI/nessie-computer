//! Provenance for the native-only SYSTEM updater, shared by inventory and IPC.
use crate::{custody::REJECTED, release::pin_protected, update_admission::root};
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::Path};

pub fn pin_image(path: &Path, pin_eku: Option<&str>) -> Result<Vec<File>, String> {
    let root = root()?;
    let bin = root.join("bin");
    let directory = path.parent().ok_or(REJECTED)?;
    let digest = directory
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(REJECTED)?;
    if directory.parent() != Some(bin.as_path())
        || !crate::custody::valid_nonce(digest)
        || path.file_name().and_then(|name| name.to_str()) != Some("nessie-computer-updater.exe")
    {
        return Err(REJECTED.into());
    }
    let mut pins = vec![
        pin_protected(&root, true)?,
        pin_protected(&bin, true)?,
        pin_protected(directory, true)?,
    ];
    let mut file = pin_protected(path, false)?;
    if file.metadata().map_err(|_| REJECTED)?.len() > 256 * 1024 * 1024 {
        return Err(REJECTED.into());
    }
    let mut sha = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|_| REJECTED)?;
        if count == 0 {
            break;
        }
        sha.update(&buffer[..count]);
    }
    if format!("{:x}", sha.finalize()) != digest {
        return Err(REJECTED.into());
    }
    nessie_windows_provenance::decide_release_signature(
        pin_eku,
        nessie_windows_provenance::collect_signature_facts(path),
    )?;
    pins.push(file);
    Ok(pins)
}

pub fn verify_process(
    process: &crate::process::Process,
    pin_eku: Option<&str>,
) -> Result<(), String> {
    if process.sid != "S-1-5-18" || process.session != 0 || !process.alive() {
        return Err(REJECTED.into());
    }
    let _pins = pin_image(&process.image, pin_eku)?;
    if !process.alive() {
        return Err(REJECTED.into());
    }
    Ok(())
}
