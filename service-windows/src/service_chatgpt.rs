//! Typed service attestation for the impersonated pairing owner. No arbitrary signing.
use crate::{
    paths::{has_executor_state, PAIRED_BY_FILE},
    supervisor::Supervisor,
};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

#[derive(Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    Pairing,
    Scope {
        profile_id: String,
    },
    Prepare {
        profile_id: String,
        public_key: String,
    },
    Confirm {
        challenge_id: String,
        digest: String,
        companion_signature: String,
        nonce: String,
    },
    Disconnect {
        profile_id: String,
        server_origin: String,
        organization_id: String,
        team_id: String,
    },
}

pub fn parse_operation(value: serde_json::Value) -> Result<Operation, String> {
    let operation: Operation =
        serde_json::from_value(value).map_err(|_| "Invalid personal attestation operation.")?;
    let identifier = match &operation {
        Operation::Pairing => return Ok(operation),
        Operation::Scope { profile_id } => profile_id,
        Operation::Disconnect {
            profile_id,
            server_origin,
            organization_id,
            team_id,
        } => {
            if server_origin.len() > 512
                || url::Url::parse(server_origin).is_err()
                || !crate::protocol::valid_identifier(organization_id)
                || !crate::protocol::valid_identifier(team_id)
            {
                return Err("Invalid personal disconnect scope.".into());
            }
            profile_id
        }
        Operation::Prepare {
            profile_id,
            public_key,
        } => {
            if !(32..=1024).contains(&public_key.len()) {
                return Err("Invalid companion public key.".into());
            }
            profile_id
        }
        Operation::Confirm {
            challenge_id,
            digest,
            companion_signature,
            nonce,
        } => {
            if digest.len() != 64
                || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                || !(32..=1024).contains(&companion_signature.len())
                || !(32..=128).contains(&nonce.len())
                || !nonce
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            {
                return Err("Invalid companion proof.".into());
            }
            challenge_id
        }
    };
    if identifier.len() != 36
        || !identifier
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err("Invalid personal attestation identity.".into());
    }
    Ok(operation)
}

fn require_pairing_owner(directory: &Path, caller: Option<&str>) -> Result<(), String> {
    let refused = || "Use the Windows account that paired this computer.".to_owned();
    let caller = caller
        .filter(|sid| nessie_windows_common::is_sid_string(sid))
        .ok_or_else(refused)?;
    let path = directory.join(PAIRED_BY_FILE);
    let entry = fs::symlink_metadata(&path).map_err(|_| refused())?;
    if !entry.is_file() || entry.file_type().is_symlink() || entry.len() > 256 {
        return Err(refused());
    }
    let owner = fs::read_to_string(path).map_err(|_| refused())?;
    if owner.trim() != caller || !nessie_windows_common::is_sid_string(owner.trim()) {
        return Err(refused());
    }
    Ok(())
}

impl Supervisor {
    pub fn personal_attestation(
        &self,
        executor_id: &str,
        operation: Operation,
        caller: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        let directory = self.state_dir(executor_id)?;
        if !has_executor_state(&directory) {
            return Err("This computer is not paired.".into());
        }
        require_pairing_owner(&directory, caller)?;
        let input = serde_json::to_value(operation)
            .map_err(|_| "Invalid personal attestation operation.")?;
        let (status, output) = self.public_json_command(
            vec![
                "personal-chatgpt-service".into(),
                "--operation-stdin".into(),
                "--state-dir".into(),
                directory.display().to_string(),
            ],
            Some(input),
        )?;
        if status != 0 {
            return Err("The service could not attest this personal connection.".into());
        }
        serde_json::from_str(&output).map_err(|_| "Invalid personal attestation response.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn another_administrator_or_missing_sid_cannot_substitute_for_the_pairing_owner() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join(PAIRED_BY_FILE), "S-1-5-21-123\n").unwrap();
        assert!(require_pairing_owner(root.path(), Some("S-1-5-21-123")).is_ok());
        assert!(require_pairing_owner(root.path(), Some("S-1-5-32-544")).is_err());
        assert!(require_pairing_owner(root.path(), Some("S-1-5-21-999")).is_err());
        assert!(require_pairing_owner(root.path(), None).is_err());
    }
    #[test]
    fn arbitrary_blobs_commands_urls_and_tokens_are_refused() {
        for field in [
            "payload",
            "command",
            "apiOrigin",
            "accessToken",
            "stateDirectory",
        ] {
            assert!(parse_operation(serde_json::json!({"operation":"prepare",
                "profileId":"11111111-1111-4111-8111-111111111111", "publicKey":"p".repeat(64), field:"forged"})).is_err());
        }
    }
}
