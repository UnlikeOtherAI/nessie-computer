#[cfg(windows)]
use crate::paths::{has_executor_state, PAIRED_BY_FILE};
use crate::supervisor::{
    configure_arguments, configure_input_arguments, describe_arguments, pair_arguments,
    parse_fingerprint, serve_arguments,
};
use crate::{manifest::VerifiedRuntime, paths::EXECUTOR_STATE_FILE, supervisor::Supervisor};
use std::{fs, path::Path};

const EXECUTOR_ID: &str = "00000000-0000-4000-8000-000000000001";

fn paired_supervisor(root: &Path) -> Supervisor {
    let state = root.join("executors").join(EXECUTOR_ID);
    fs::create_dir_all(&state).expect("state directory");
    fs::write(state.join(EXECUTOR_STATE_FILE), b"{}").expect("paired state");
    Supervisor::new(
        root.to_path_buf(),
        VerifiedRuntime {
            native_helper: root.join("native-helper"),
            node_executable: root.join("missing-node"),
            root: root.to_path_buf(),
        },
    )
}

#[cfg(windows)]
fn scripted_supervisor(root: &Path) -> Supervisor {
    let mut supervisor = paired_supervisor(root);
    supervisor.direct_runtime_fixture = true;
    let node = std::process::Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .expect("Node is required for Windows executor lifecycle tests");
    assert!(
        node.status.success(),
        "Node is required for Windows executor lifecycle tests"
    );
    let script = root.join("nessie-executor.cjs");
    fs::write(
        &script,
        "const fs=require('fs');const a=process.argv.slice(2);const d=a[a.indexOf('--state-dir')+1];if(a[0]==='unpair'){if(fs.existsSync(d+'/unpair-refuse.marker'))process.exit(1);fs.rmSync(d+'/executor-state.json');process.stdout.write('{\"status\":\"removed\",\"signedOff\":false}\\n')}else if(a[0]==='connect'){fs.writeFileSync(d+'/connect.marker','');if(fs.existsSync(d+'/fenced.marker')){process.stderr.write('Executor connection is fenced.\\n');process.exit(1)}const go=()=>{if(fs.existsSync(d+'/connect-block.marker'))return setTimeout(go,5);process.exit(fs.existsSync(d+'/offline.marker')?1:0)};go()}else{fs.writeFileSync(d+'/serve.marker','');setInterval(()=>{if(fs.existsSync(d+'/crash.marker'))process.exit(0)},5);process.stdin.on('end',()=>process.exit(0)).resume();}",
    )
    .expect("script");
    supervisor.runtime.node_executable =
        std::path::PathBuf::from(String::from_utf8(node.stdout).expect("Node path").trim());
    supervisor
}

#[test]
fn production_commands_use_the_native_creation_gate_before_the_fixed_cli() {
    let root = tempfile::tempdir().unwrap();
    let supervisor = paired_supervisor(root.path());
    let command = supervisor.command();
    assert_eq!(
        command.get_program(),
        supervisor.runtime.native_helper.as_os_str()
    );
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        vec![
            std::ffi::OsStr::new("managed-runtime"),
            std::ffi::OsStr::new("--")
        ]
    );
}

#[test]
fn pairing_arguments_keep_sensitive_input_off_the_process_list() {
    let arguments = pair_arguments(
        "https://api.nessie.works",
        "00000000-0000-4000-8000-000000000001",
        Path::new("/service/state"),
    );
    assert!(arguments.contains(&"--pair-input-stdin".to_owned()));
    assert!(!arguments
        .iter()
        .any(|argument| argument.contains("challenge-value")));
    assert!(!arguments
        .iter()
        .any(|argument| argument.contains("workspace")));
}

#[test]
fn the_daemon_is_started_with_the_liveness_pipe_that_stops_it() {
    // Closing this pipe is the whole Windows stop path; a `serve` without
    // the flag would have to be terminated instead.
    assert_eq!(
        serve_arguments(Path::new("/service/state")),
        vec![
            "serve",
            "--parent-liveness-stdin",
            "--state-dir",
            "/service/state"
        ],
    );
}

#[test]
fn a_policy_is_passed_as_the_canonical_comma_separated_list() {
    assert_eq!(
        configure_arguments(
            Path::new("/service/state"),
            &["file.read".to_owned(), "sandbox.stop".to_owned()],
        ),
        vec![
            "configure",
            "--state-dir",
            "/service/state",
            "--operations",
            "file.read,sandbox.stop"
        ],
    );
}

#[test]
fn configuration_input_uses_stdin_and_keeps_the_payload_off_argv() {
    assert_eq!(
        configure_input_arguments(Path::new("/service/state")),
        vec![
            "configure",
            "--configuration-input-stdin",
            "--state-dir",
            "/service/state"
        ],
    );
}

#[test]
fn describe_asks_for_the_credential_free_projection() {
    assert_eq!(
        describe_arguments(Path::new("/service/state")),
        vec!["describe", "--state-dir", "/service/state"],
    );
}

#[test]
fn fingerprint_is_read_from_the_cli_success_line() {
    assert_eq!(
        parse_fingerprint(
            "Pairing request submitted. Confirm fingerprint abc123 in Nessie, then run connect.\n"
        ),
        Some("abc123".to_owned()),
    );
    assert_eq!(parse_fingerprint(""), None);
    assert_eq!(parse_fingerprint("no fingerprint here"), None);
}

#[test]
fn a_requested_start_is_visible_while_recovery_retries_and_stop_cancels_it() {
    let directory = tempfile::tempdir().expect("temporary state");
    let mut supervisor = paired_supervisor(directory.path());
    assert_eq!(supervisor.start(EXECUTOR_ID), Ok("starting".to_owned()));
    assert_eq!(supervisor.start(EXECUTOR_ID), Ok("starting".to_owned()));
    assert_eq!(supervisor.status(EXECUTOR_ID), Ok("starting".to_owned()));
    // The packaged command cannot spawn in this portable test, which is a
    // deterministic stand-in for a boot-time remote outage. It remains
    // desired until a person explicitly stops it.
    assert_eq!(supervisor.recover_due().len(), 1);
    assert_eq!(supervisor.status(EXECUTOR_ID), Ok("starting".to_owned()));
    assert_eq!(supervisor.stop(EXECUTOR_ID), Ok("stopped".to_owned()));
    assert!(supervisor.recover_due().is_empty());
    assert_eq!(supervisor.status(EXECUTOR_ID), Ok("stopped".to_owned()));
}

#[cfg(windows)]
fn until(phase: &str, mut condition: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !condition() {
        assert!(
            std::time::Instant::now() < deadline,
            "fixture phase did not arrive: {phase}"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[cfg(windows)]
#[test]
fn recovery_observes_connect_serve_crash_backoff_stop_and_shutdown() {
    let directory = tempfile::tempdir().expect("temporary state");
    let state = directory.path().join("executors").join(EXECUTOR_ID);
    let mut supervisor = scripted_supervisor(directory.path());
    supervisor.start(EXECUTOR_ID).expect("queue start");
    supervisor.recover_due();
    until("initial connect starts", || {
        supervisor.recover_due();
        state.join("connect.marker").exists()
    });
    until("initial connect reaches serve", || {
        supervisor.recover_due();
        state.join("serve.marker").exists()
    });
    assert_eq!(supervisor.status(EXECUTOR_ID), Ok("running".to_owned()));
    fs::write(state.join("crash.marker"), b"").expect("request crash");
    until("crashed daemon schedules retry", || {
        supervisor.recover_due();
        supervisor.retry_after.contains_key(EXECUTOR_ID)
    });
    let delay = supervisor.retry_delay[EXECUTOR_ID];
    assert!(delay >= std::time::Duration::from_secs(10));
    assert!(
        supervisor.recover_due().is_empty(),
        "crash must not relaunch immediately"
    );
    supervisor.stop(EXECUTOR_ID).expect("stop cancels retries");
    assert!(supervisor.recover_due().is_empty());
    supervisor.request_shutdown();
    assert!(supervisor.desired.is_empty() && supervisor.connections.is_empty());
}

#[cfg(windows)]
#[test]
fn recovery_retries_an_offline_connect_then_recovers_and_shutdown_cancels_a_pending_connect() {
    let directory = tempfile::tempdir().expect("temporary state");
    let state = directory.path().join("executors").join(EXECUTOR_ID);
    let mut supervisor = scripted_supervisor(directory.path());
    fs::write(state.join("offline.marker"), b"").expect("offline fixture");
    supervisor.start(EXECUTOR_ID).expect("queue start");
    supervisor.recover_due();
    until("offline connect exits and schedules retry", || {
        supervisor.recover_due();
        // Start already inserts retry_after. Wait until the failed child has
        // been observed and recovery has scheduled its actual backoff.
        !supervisor.connections.contains_key(EXECUTOR_ID)
            && supervisor.retry_delay.contains_key(EXECUTOR_ID)
            && supervisor.retry_after.contains_key(EXECUTOR_ID)
    });
    assert!(state.join("connect.marker").exists(), "offline connect ran");
    assert!(
        !state.join("serve.marker").exists(),
        "offline connect must not launch serve"
    );
    assert!(
        supervisor.retry_after[EXECUTOR_ID] > std::time::Instant::now(),
        "offline connect must schedule a future retry"
    );
    fs::remove_file(state.join("offline.marker")).expect("restore network");
    supervisor
        .retry_after
        .insert(EXECUTOR_ID.to_owned(), std::time::Instant::now());
    until("restored connection reaches serve", || {
        supervisor.recover_due();
        state.join("serve.marker").exists()
    });
    assert_eq!(supervisor.status(EXECUTOR_ID), Ok("running".to_owned()));

    supervisor.request_shutdown();
    let blocked = tempfile::tempdir().expect("blocked state");
    let blocked_state = blocked.path().join("executors").join(EXECUTOR_ID);
    let mut blocked_supervisor = scripted_supervisor(blocked.path());
    fs::write(blocked_state.join("connect-block.marker"), b"").expect("block connect");
    blocked_supervisor
        .start(EXECUTOR_ID)
        .expect("queue blocked connect");
    blocked_supervisor.recover_due();
    until("blocked connect starts before shutdown", || {
        blocked_state.join("connect.marker").exists()
    });
    blocked_supervisor.request_shutdown();
    fs::remove_file(blocked_state.join("connect-block.marker")).expect("unblock connect");
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert!(blocked_supervisor.desired.is_empty() && blocked_supervisor.connections.is_empty());
    assert!(
        !blocked_state.join("serve.marker").exists(),
        "shutdown must not launch serve"
    );
}

#[cfg(windows)]
#[test]
fn remove_signs_off_deletes_the_state_and_forgets_the_pairing_account() {
    let directory = tempfile::tempdir().expect("temporary state");
    let state = directory.path().join("executors").join(EXECUTOR_ID);
    let mut supervisor = scripted_supervisor(directory.path());
    // The fixture CLI lives in the root, not the state directory, so an
    // emptied state directory is what the CLI would leave behind.
    let sid = "S-1-5-21-1004336348-1177238915-682003330-1001";
    fs::write(state.join(PAIRED_BY_FILE), format!("{sid}\n")).expect("pairing account");
    assert_eq!(supervisor.remove(EXECUTOR_ID, Some(sid)), Ok(false));
    assert!(!state.exists(), "the emptied state directory is removed");
    assert!(supervisor.statuses().is_empty());
    let log =
        fs::read_to_string(directory.path().join("logs").join("service.log")).expect("service log");
    assert!(log.contains(&format!(
        "executor {EXECUTOR_ID} removed from this computer by {sid}"
    )));
}

#[cfg(windows)]
#[test]
fn remove_stops_a_running_daemon_before_unpairing_and_leaves_unknown_files() {
    let directory = tempfile::tempdir().expect("temporary state");
    let state = directory.path().join("executors").join(EXECUTOR_ID);
    let mut supervisor = scripted_supervisor(directory.path());
    supervisor.start(EXECUTOR_ID).expect("queue start");
    until("daemon starts before removal", || {
        supervisor.recover_due();
        state.join("serve.marker").exists()
    });
    assert_eq!(supervisor.status(EXECUTOR_ID), Ok("running".to_owned()));
    assert_eq!(supervisor.remove(EXECUTOR_ID, None), Ok(false));
    assert!(supervisor.children.is_empty() && supervisor.desired.is_empty());
    assert!(
        !has_executor_state(&state),
        "the connection is no longer paired"
    );
    assert!(
        state.join("serve.marker").exists(),
        "files nobody named are left for a person to inspect"
    );
    assert!(supervisor.statuses().is_empty());
}

#[cfg(windows)]
#[test]
fn a_refused_unpair_keeps_the_pairing_and_leaves_it_stopped() {
    let directory = tempfile::tempdir().expect("temporary state");
    let state = directory.path().join("executors").join(EXECUTOR_ID);
    let mut supervisor = scripted_supervisor(directory.path());
    fs::write(state.join("unpair-refuse.marker"), b"").expect("refusal fixture");
    assert_eq!(
        supervisor.remove(EXECUTOR_ID, None),
        Err("The Nessie Computer service couldn’t remove this team. Try again.".to_owned()),
    );
    assert!(has_executor_state(&state));
    assert_eq!(supervisor.status(EXECUTOR_ID), Ok("stopped".to_owned()));
}

#[cfg(windows)]
#[test]
fn a_recognised_refusal_waits_for_the_owner_instead_of_being_retried() {
    let directory = tempfile::tempdir().expect("temporary state");
    let state = directory.path().join("executors").join(EXECUTOR_ID);
    let mut supervisor = scripted_supervisor(directory.path());
    fs::write(state.join("fenced.marker"), b"").expect("fenced fixture");
    supervisor.start(EXECUTOR_ID).expect("queue start");
    until("the fenced connect is observed", || {
        supervisor.recover_due();
        !supervisor.desired.contains(EXECUTOR_ID)
    });
    let row = supervisor.statuses().remove(0);
    assert_eq!(row.daemon_status, "stopped");
    let failure = row.failure.expect("the refusal is reported");
    assert_eq!(failure.code.as_deref(), Some("EXECUTOR_CONNECTION_FENCED"));
    assert_eq!(failure.message, "Executor connection is fenced.");
    assert!(!supervisor.retry_after.contains_key(EXECUTOR_ID), "a refusal is not retried");
    assert!(supervisor.recover_due().is_empty());
    // The owner's remedy starts it again, and a connected team has no failure.
    fs::remove_file(state.join("fenced.marker")).expect("clear fixture");
    supervisor.start(EXECUTOR_ID).expect("remedy start");
    until("the restarted team serves", || {
        supervisor.recover_due();
        state.join("serve.marker").exists()
    });
    assert_eq!(supervisor.statuses()[0].failure, None);
    supervisor.request_shutdown();
}
