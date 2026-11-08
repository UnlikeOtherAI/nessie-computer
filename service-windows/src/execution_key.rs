//! Execution-only key and append-only replay journal under the existing service-owned root.
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{pkcs8::EncodePublicKey, Signer, SigningKey};
use nessie_windows_common::{custody::REJECTED, release::pin_service_private};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub fn sha(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
pub use nessie_windows_common::execution::canonical;
pub struct Key {
    key: SigningKey,
    pub key_id: String,
    pub public_key: String,
    pub directory: PathBuf,
    _pins: Vec<File>,
}
impl Key {
    pub fn open(root: &Path, executor: &str, create: bool) -> Result<Self, String> {
        if !crate::protocol::valid_identifier(executor) {
            return Err(REJECTED.into());
        }
        let mut pins = vec![pin_service_private(root, true)?];
        let directory = root.join("execution-issuers");
        if create {
            std::fs::create_dir_all(&directory).map_err(|_| REJECTED)?;
        }
        pins.push(pin_service_private(&directory, true)?);
        let directory = directory.join(executor);
        if create {
            std::fs::create_dir_all(&directory).map_err(|_| REJECTED)?;
        }
        pins.push(pin_service_private(&directory, true)?);
        let path = directory.join("execution.seed");
        if create && !path.try_exists().map_err(|_| REJECTED)? {
            let mut seed = [0u8; 32];
            if unsafe {
                windows_sys::Win32::Security::Cryptography::BCryptGenRandom(
                    std::ptr::null_mut(),
                    seed.as_mut_ptr(),
                    32,
                    2,
                )
            } < 0
            {
                return Err(REJECTED.into());
            }
            let result = (|| {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .map_err(|_| REJECTED)?;
                file.write_all(&seed)
                    .and_then(|()| file.sync_all())
                    .map_err(|_| REJECTED)
            })();
            for b in &mut seed {
                unsafe {
                    std::ptr::write_volatile(b, 0);
                }
            }
            result?;
        }
        let mut held = pin_service_private(&path, false)?;
        if held.metadata().map_err(|_| REJECTED)?.len() != 32 {
            return Err(REJECTED.into());
        }
        let mut seed = [0u8; 32];
        held.read_exact(&mut seed).map_err(|_| REJECTED)?;
        let key = SigningKey::from_bytes(&seed);
        for b in &mut seed {
            unsafe {
                std::ptr::write_volatile(b, 0);
            }
        }
        pins.push(held);
        let der = key
            .verifying_key()
            .to_public_key_der()
            .map_err(|_| REJECTED)?;
        Ok(Self {
            key,
            key_id: format!("{:x}", Sha256::digest(der.as_bytes())),
            public_key: STANDARD.encode(der.as_bytes()),
            directory,
            _pins: pins,
        })
    }
    pub fn sign(&self, domain: &str, value: &Value) -> Result<Value, String> {
        use nessie_windows_common::execution::*;
        if ![
            ISSUER_DOMAIN,
            GRAPH_DOMAIN,
            RESERVATION_DOMAIN,
            PREPARATION_DOMAIN,
            ASSOCIATION_DOMAIN,
            HISTORY_RESULT_DOMAIN,
            nessie_windows_common::execution_frame::PREPARATION_DOMAIN,
        ]
        .contains(&domain)
        {
            return Err(REJECTED.into());
        }
        let payload = canonical(value)?;
        Ok(
            json!({"domain":domain,"payload":payload,"keyId":self.key_id,
            "signature":URL_SAFE_NO_PAD.encode(self.key.sign(&signing_bytes(domain,&payload)).to_bytes())}),
        )
    }
    /// Claim before any effect or proof; uncertain/crashed claims never become replayable.
    pub fn claim(&self, kind: &str, id: &str, value: &Value) -> Result<(), String> {
        if !nessie_windows_common::custody::valid_nonce(id)
            || ![
                "nonce",
                "reserve",
                "prepare",
                "launch",
                "associate",
                "enroll",
                "graph",
                "process-creation",
                "process-resumed",
                "process-cleared",
                "frame-consumed",
                "effect-consumed",
            ]
            .contains(&kind)
        {
            return Err(REJECTED.into());
        }
        let path = self.directory.join(format!("{kind}-{id}.json"));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|_| REJECTED)?;
        file.write_all(canonical(value)?.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|_| REJECTED)?;
        drop(file);
        pin_service_private(&path, false)?;
        Ok(())
    }
    pub fn read(&self, kind: &str, id: &str) -> Result<Value, String> {
        if !nessie_windows_common::custody::valid_nonce(id)
            || ![
                "reserve",
                "prepare",
                "launch",
                "associate",
                "enroll",
                "graph",
                "process-cleared",
            ]
            .contains(&kind)
        {
            return Err(REJECTED.into());
        }
        let mut bytes = Vec::new();
        pin_service_private(&self.directory.join(format!("{kind}-{id}.json")), false)?
            .take(65537)
            .read_to_end(&mut bytes)
            .map_err(|_| REJECTED)?;
        if bytes.len() > 65536 {
            return Err(REJECTED.into());
        }
        serde_json::from_slice(&bytes).map_err(|_| REJECTED.into())
    }
    pub fn cleared_process(&self, id: &str) -> Result<Option<Value>, String> {
        if !nessie_windows_common::custody::valid_nonce(id) {
            return Err(REJECTED.into());
        }
        let path = self.directory.join(format!("process-cleared-{id}.json"));
        if !path.try_exists().map_err(|_| REJECTED)? {
            return Ok(None);
        }
        self.read("process-cleared", id).map(Some)
    }
    pub fn associated(&self, id: &str) -> Result<bool, String> {
        if !nessie_windows_common::custody::valid_nonce(id) {
            return Err(REJECTED.into());
        }
        let path = self.directory.join(format!("associate-{id}.json"));
        if !path.try_exists().map_err(|_| REJECTED)? {
            return Ok(false);
        }
        self.read("associate", id)?;
        Ok(true)
    }
}
