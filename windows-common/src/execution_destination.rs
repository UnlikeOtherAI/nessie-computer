//! Private local storage custody. These records grant no SQL/provider action.
use crate::{
    custody::{valid_nonce, REJECTED},
    execution_resource::Object,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const WRITER_FILE: &str = "native-execution-owner.lock";
pub const JOURNAL_REFERENCE: &str = "journal";
fn lowercase_digest(value: &str) -> bool {
    valid_nonce(value) && value.bytes().all(|byte| !byte.is_ascii_uppercase())
}

pub fn directory(profile: &Path, executor: &str, physical_root: &str) -> Result<PathBuf, String> {
    if !profile.is_absolute()
        || !crate::execution::identifier(executor)
        || !physical_root
            .strip_prefix("windows-file-id:")
            .is_some_and(lowercase_digest)
    {
        return Err(REJECTED.into());
    }
    let executor = format!("{:x}", Sha256::digest(executor.as_bytes()));
    let key = format!(
        "{:x}",
        Sha256::digest(format!("nessie:t3-session-state:v1\0execution-state:{physical_root}").as_bytes())
    );
    Ok(profile
        .join(".local")
        .join("state")
        .join("nessie-t3-graphs")
        .join(executor)
        .join("t3-sessions")
        .join(key))
}
pub fn filename(reference: &str) -> Result<String, String> {
    if reference == JOURNAL_REFERENCE {
        return Ok("capture-journal.sqlite".into());
    }
    let digest = reference
        .strip_prefix("t3-capture:v1:")
        .filter(|s| lowercase_digest(s))
        .ok_or(REJECTED)?;
    Ok(format!("capture-{digest}.sqlite"))
}
pub fn valid_object(object: &Object, directory: bool) -> bool {
    object.handle != 0
        && object.private
        && crate::execution::identifier(&object.identity)
        && object.kind == if directory { "directory" } else { "database" }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub version: u32,
    pub resource_id: String,
    pub resource_generation: String,
    pub runtime_generation: String,
    pub directory_identity: String,
    pub writer_identity: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileReceipt {
    pub version: u32,
    pub runtime_generation: String,
    pub reference: String,
    pub database_identity: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn execution_destination_layout_never_accepts_a_path_or_traversal_reference() {
        assert_eq!(filename("journal").unwrap(), "capture-journal.sqlite");
        assert_eq!(
            filename(&format!("t3-capture:v1:{}", "a".repeat(64))).unwrap(),
            format!("capture-{}.sqlite", "a".repeat(64))
        );
        for value in [
            "",
            "../journal",
            "t3-capture:v1:../file",
            "C:\\source.sqlite",
            "journal\0",
        ] {
            assert!(filename(value).is_err());
        }
        assert!(directory(
            Path::new("relative"),
            "executor",
            &format!("windows-file-id:{}", "b".repeat(64))
        )
        .is_err());
        assert!(directory(Path::new("C:\\Users\\owner"), "executor", "caller-selected-root").is_err());
        assert!(filename(&format!("t3-capture:v1:{}", "A".repeat(64))).is_err());
        let profile = std::env::temp_dir();
        assert_eq!(
            directory(&profile, "executor", &format!("windows-file-id:{}", "b".repeat(64))).unwrap(),
            profile
                .join(".local")
                .join("state")
                .join("nessie-t3-graphs")
                .join("8fba13dab71d6fdd8a9b9db1f06e81315dfbfd69167b6097f724604db3c91cdf")
                .join("t3-sessions")
                .join("70553936a7be71e5e0fd6af153070d9dd77babd72f113fc682204c7098168826")
        );
    }
}
