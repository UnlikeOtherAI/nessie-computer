use super::*;
use crate::{
    legacy_pairing::LegacyPairing,
    paths::{pending_root, PAIRED_BY_FILE},
    protocol::PairCommand,
};
use std::{fs, path::Path};

const OWNER: Option<&str> = Some("S-1-5-21-123");
const EXECUTOR: &str = "00000000-0000-4000-8000-000000000001";
const SCRIPT: &str = r#"
const fs = require('fs');
const args = process.argv.slice(2);
const directory = args[args.indexOf('--state-dir') + 1];
let input = '';
process.stdin.on('data', chunk => input += chunk).on('end', () => {
  const path = directory + '/executor-pairing.json';
  if (!fs.existsSync(path)) fs.writeFileSync(path, 'same-key-and-request');
  else if (fs.readFileSync(path, 'utf8') !== 'same-key-and-request') process.exit(3);
  fs.appendFileSync(directory + '/invocations', '1');
  if (fs.existsSync(directory + '/timeout')) { setInterval(() => {}, 1000); return; }
  if (fs.existsSync(directory + '/lost-response')) process.exit(1);
  fs.writeFileSync(directory + '/executor-state.json', JSON.stringify({ executorId: '00000000-0000-4000-8000-000000000001' }));
  if (fs.existsSync(directory + '/lost-output')) process.exit(1);
  process.stdout.write('Confirm fingerprint sha256:' + 'a'.repeat(64) + ' in Nessie.\n');
});
"#;

fn command() -> PairCommand {
    PairCommand {
        api_base_url: "https://api.nessie.works".into(),
        enrollment_id: "enrollment".into(),
        challenge: "challenge".into(),
        workspace_root: "C:\\workspace".into(),
    }
}
fn secure(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())
}
fn fixture(root: &Path) -> Supervisor {
    let node = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .expect("Node fixture runtime");
    assert!(node.status.success());
    fs::write(root.join("nessie-executor.cjs"), SCRIPT).unwrap();
    let mut supervisor = Supervisor::new(
        root.to_owned(),
        VerifiedRuntime {
            root: root.to_owned(),
            native_helper: root.join("unused-helper"),
            node_executable: PathBuf::from(String::from_utf8(node.stdout).unwrap().trim()),
        },
    );
    supervisor.direct_runtime_fixture = true;
    supervisor
}

#[test]
fn failed_timed_out_and_lost_output_pairings_reuse_staging_after_supervisor_restart() {
    for failure in ["lost-response", "timeout", "lost-output"] {
        let root = tempfile::tempdir().unwrap();
        let mut host = fixture(root.path());
        // The wrapper publishes the original owner before the child can run.
        let attempt = LegacyPairing::open(root.path(), &command(), OWNER, secure).unwrap();
        secure(&attempt.staging).unwrap();
        fs::write(attempt.staging.join(failure), "").unwrap();
        drop(attempt);
        assert!(host
            .pair_with_timeout(&command(), OWNER, secure, Duration::from_secs(2))
            .is_err());
        let staging = pending_root(root.path()).join("enrollment");
        assert!(host.pair(&command(), Some("S-1-5-21-999"), secure).is_err());
        assert_eq!(
            fs::read_to_string(staging.join("invocations")).unwrap(),
            "1"
        );
        assert_eq!(
            fs::read_to_string(staging.join("executor-pairing.json")).unwrap(),
            "same-key-and-request"
        );
        fs::remove_file(staging.join(failure)).unwrap();
        drop(host);
        let mut restarted = fixture(root.path());
        let result = restarted.pair(&command(), OWNER, secure).unwrap();
        assert_eq!(
            result,
            (EXECUTOR.into(), format!("sha256:{}", "a".repeat(64)))
        );
        let destination = restarted.state_dir(EXECUTOR).unwrap();
        assert_eq!(
            fs::read_to_string(destination.join("invocations")).unwrap(),
            "11"
        );
        assert_eq!(
            fs::read_to_string(destination.join(PAIRED_BY_FILE))
                .unwrap()
                .trim(),
            OWNER.unwrap()
        );
        assert!(!destination.join("executor-pairing.json").exists());
        assert_eq!(restarted.pair(&command(), OWNER, secure).unwrap(), result);
        assert_eq!(
            fs::read_to_string(destination.join("invocations")).unwrap(),
            "11",
            "completed retries run no CLI"
        );
    }
}

#[test]
fn restart_between_recording_success_and_promotion_resumes_without_another_cli() {
    let root = tempfile::tempdir().unwrap();
    let mut host = fixture(root.path());
    let attempt = LegacyPairing::open(root.path(), &command(), OWNER, secure).unwrap();
    secure(&attempt.staging).unwrap();
    fs::write(
        attempt.staging.join("executor-state.json"),
        format!(r#"{{"executorId":"{EXECUTOR}"}}"#),
    )
    .unwrap();
    attempt
        .record(EXECUTOR.into(), "fingerprint".into())
        .unwrap();
    drop(attempt);
    assert_eq!(
        host.pair(&command(), OWNER, secure).unwrap(),
        (EXECUTOR.into(), "fingerprint".into())
    );
    let destination = host.state_dir(EXECUTOR).unwrap();
    assert!(!destination.join("invocations").exists());
    assert_eq!(
        fs::read_to_string(destination.join(PAIRED_BY_FILE))
            .unwrap()
            .trim(),
        OWNER.unwrap()
    );
}
