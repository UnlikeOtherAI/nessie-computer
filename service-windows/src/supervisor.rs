//! The daemon's host: the same child supervision the desktop shell performs,
//! run by a service account instead of a person's session.
//!
//! Every invocation is the packaged Node running the packaged bundle, with the
//! two environment facts the CLI reads — `NESSIE_EXECUTOR_PACKAGED_CLI=1` arms
//! its own runtime verification, and `NESSIE_EXECUTOR_SUPERVISOR=service` is
//! what makes the descriptor, the server, and the Executors page say which
//! controls apply to this executor id.
//!
//! Stopping is closing the parent-liveness pipe the daemon already watches, and
//! waiting. `TerminateProcess` is never the normal path: a daemon with guests
//! still tearing down is waited for and then refused, never killed.

use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    thread::sleep,
    time::{Duration, Instant},
};

use crate::{
    lease::unowned_daemon_is_stopping,
    manifest::VerifiedRuntime,
    paths::{executor_state_dir, has_executor_state, paired_executors},
    protocol::ExecutorStatus,
};

const STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the packaged CLI is given for a one-shot command (`pair`,
/// `connect`, `configure`). Long enough for a slow network round trip, short
/// enough that a wedged child never holds the control pipe open.
pub(crate) const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

/// A booting service must accept SCM and tray controls even while Nessie is
/// unreachable. Connecting is therefore attempted by the recovery sweep and
/// is bounded more tightly than a user-requested configuration command.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_INITIAL: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(300);

pub(crate) struct ManagedDaemon {
    child: Child,
    /// Closing this pipe tells `serve` to stop all guest sessions before it
    /// releases the durable daemon lease. It has to be droppable while the child
    /// is still held, because closing it *is* the stop request.
    parent_liveness: Option<ChildStdin>,
}

pub(crate) struct PendingConnection {
    child: Child,
    started_at: Instant,
}

pub struct Supervisor {
    pub(crate) children: BTreeMap<String, ManagedDaemon>,
    pub(crate) connections: BTreeMap<String, PendingConnection>,
    pub(crate) desired: BTreeSet<String>,
    retry_after: BTreeMap<String, Instant>,
    retry_delay: BTreeMap<String, Duration>,
    pub(crate) root: PathBuf,
    runtime: VerifiedRuntime,
    #[cfg(test)]
    direct_runtime_fixture: bool,
}

/// The argv for one packaged CLI invocation. Split out so what reaches a process
/// list is asserted rather than trusted: a challenge and a workspace path travel
/// on standard input, never here.
#[allow(unused_imports)] // Re-exported for the focused supervisor argv tests.
pub(crate) use crate::supervisor_commands::{
    configure_arguments, configure_input_arguments, describe_arguments, pair_arguments,
    serve_arguments,
};

pub(crate) fn wait_bounded(child: &mut Child, timeout: Duration) -> Result<Option<i32>, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Err(_) => {
                return Err("Nessie Executor could not inspect its packaged command.".to_owned())
            }
            Ok(Some(status)) => return Ok(Some(status.code().unwrap_or(1))),
            Ok(None) if Instant::now() >= deadline => return Ok(None),
            Ok(None) => sleep(Duration::from_millis(50)),
        }
    }
}

/// Reads the fingerprint the CLI prints on successful pairing. The whole
/// point of the pairing surface is that a person compares this in Nessie
/// before the executor is allowed to do anything, so it is taken from the
/// CLI's own output rather than recomputed here from a machine key this
/// service never sees.
pub(crate) fn parse_fingerprint(output: &str) -> Option<String> {
    let prefix = "Confirm fingerprint ";
    output.lines().find_map(|line| {
        line.find(prefix).and_then(|index| {
            let rest = &line[index + prefix.len()..];
            rest.split_whitespace().next().map(|value| value.to_owned())
        })
    })
}

impl Supervisor {
    pub fn new(root: PathBuf, runtime: VerifiedRuntime) -> Self {
        Self {
            children: BTreeMap::new(),
            connections: BTreeMap::new(),
            desired: BTreeSet::new(),
            retry_after: BTreeMap::new(),
            retry_delay: BTreeMap::new(),
            root,
            runtime,
            #[cfg(test)]
            direct_runtime_fixture: false,
        }
    }

    pub fn runtime(&self) -> &VerifiedRuntime {
        &self.runtime
    }

    /// The packaged Node running the packaged bundle. Nothing else is ever
    /// executed, and the two supervisor facts are set on every invocation.
    pub(crate) fn command(&self) -> Command {
        #[cfg(test)]
        if self.direct_runtime_fixture {
            let mut command = Command::new(&self.runtime.node_executable);
            command
                .arg(self.runtime.bundle())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            return command;
        }
        let mut command = Command::new(&self.runtime.native_helper);
        command.args(["managed-runtime", "--"]);
        command.env("NESSIE_EXECUTOR_PACKAGED_CLI", "1");
        command.env("NESSIE_EXECUTOR_SUPERVISOR", "service");
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }

    /// Runs one packaged command to completion. Its output is never captured or
    /// reported: a refusal names what was refused, never what a child printed.
    pub(crate) fn run_to_completion(
        &self,
        arguments: Vec<String>,
        refusal: &str,
    ) -> Result<(), String> {
        let mut child = self
            .command()
            .args(arguments)
            .spawn()
            .map_err(|_| "Nessie Executor could not start its packaged command.".to_owned())?;
        match wait_bounded(&mut child, COMMAND_TIMEOUT)? {
            Some(0) => Ok(()),
            Some(_) => Err(refusal.to_owned()),
            None => {
                // A wedged one-shot command is not a daemon with guests to tear
                // down, and it must not hold the control pipe open forever.
                let _ = child.kill();
                Err(refusal.to_owned())
            }
        }
    }

    /// Runs a one-shot command that reads its payload from stdin. Used for
    /// `configure --configuration-input-stdin` so the whole policy travels on a
    /// pipe, never in a process list.
    pub(crate) fn run_to_completion_with_input(
        &self,
        arguments: Vec<String>,
        input: serde_json::Value,
        refusal: &str,
    ) -> Result<(), String> {
        let mut child = self
            .command()
            .args(arguments)
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|_| "Nessie Executor could not start its packaged command.".to_owned())?;
        let mut standard_input = child.stdin.take().ok_or_else(|| {
            "Nessie Executor could not provide the configuration input securely.".to_owned()
        })?;
        let bytes = serde_json::to_vec(&input)
            .map_err(|_| "Nessie Executor could not prepare the configuration input.".to_owned())?;
        standard_input.write_all(&bytes).map_err(|_| {
            "Nessie Executor could not provide the configuration input securely.".to_owned()
        })?;
        drop(standard_input);
        match wait_bounded(&mut child, COMMAND_TIMEOUT)? {
            Some(0) => Ok(()),
            Some(_) => Err(refusal.to_owned()),
            None => {
                let _ = child.kill();
                Err(refusal.to_owned())
            }
        }
    }

    /// Runs a one-shot command and returns its stdout. Used for `describe`,
    /// whose credential-free JSON is handed straight back to the tray.
    pub(crate) fn run_to_completion_with_output(
        &self,
        arguments: Vec<String>,
        refusal: &str,
    ) -> Result<String, String> {
        let mut child = self
            .command()
            .args(arguments)
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|_| "Nessie Executor could not start its packaged command.".to_owned())?;
        let outcome = wait_bounded(&mut child, COMMAND_TIMEOUT)?;
        let mut stdout = String::new();
        if let Some(mut pipe) = child.stdout.take() {
            let _ = pipe.read_to_string(&mut stdout);
        }
        match outcome {
            Some(0) => Ok(stdout),
            Some(_) => Err(refusal.to_owned()),
            None => {
                let _ = child.kill();
                Err(refusal.to_owned())
            }
        }
    }

    fn child_status(&mut self, executor_id: &str) -> &'static str {
        let running = matches!(
            self.children
                .get_mut(executor_id)
                .map(|daemon| daemon.child.try_wait()),
            Some(Ok(None))
        );
        if running {
            "running"
        } else {
            "stopped"
        }
    }

    pub(crate) fn state_dir(&self, executor_id: &str) -> Result<PathBuf, String> {
        executor_state_dir(&self.root, executor_id)
    }

    pub fn status(&mut self, executor_id: &str) -> Result<String, String> {
        let state_dir = self.state_dir(executor_id)?;
        let local = self.child_status(executor_id);
        if local == "stopped" && unowned_daemon_is_stopping(&state_dir) {
            return Ok("stopping".to_owned());
        }
        if local == "stopped"
            && (self.desired.contains(executor_id) || self.connections.contains_key(executor_id))
        {
            return Ok("starting".to_owned());
        }
        if local == "stopped" {
            self.children.remove(executor_id);
        }
        Ok(local.to_owned())
    }

    /// Every paired executor and the state its daemon is in.
    pub fn statuses(&mut self) -> Vec<ExecutorStatus> {
        paired_executors(&self.root)
            .into_iter()
            .filter_map(|executor_id| {
                let daemon_status = self.status(&executor_id).ok()?;
                Some(ExecutorStatus {
                    daemon_status,
                    executor_id,
                    workspace_configured: true,
                })
            })
            .collect()
    }

    /// Requests that an executor run. The recovery sweep performs the network
    /// connection; this makes Start answer promptly even when Nessie is down.
    pub fn start(&mut self, executor_id: &str) -> Result<String, String> {
        let state_dir = self.state_dir(executor_id)?;
        if !has_executor_state(&state_dir) {
            return Err("This executor has not been paired on this computer.".to_owned());
        }
        if state_dir.join("executor-pairing-code.json").exists() {
            return Err("Finish pairing this computer before starting it.".to_owned());
        }
        if self.child_status(executor_id) == "running" {
            return Ok("running".to_owned());
        }
        if self.desired.contains(executor_id) || self.connections.contains_key(executor_id) {
            return Ok("starting".to_owned());
        }
        self.desired.insert(executor_id.to_owned());
        self.retry_after
            .insert(executor_id.to_owned(), Instant::now());
        Ok("starting".to_owned())
    }

    fn start_due(&mut self, executor_id: &str) -> Result<String, String> {
        let state_dir = self.state_dir(executor_id)?;
        if unowned_daemon_is_stopping(&state_dir) {
            return Err(
                "The prior daemon is still tearing down. Wait for it to finish before starting again."
                    .to_owned(),
            );
        }
        let connection_arguments = vec![
            "connect".to_owned(),
            "--state-dir".to_owned(),
            state_dir.display().to_string(),
        ];
        let mut command = self.command();
        command.args(connection_arguments);
        let child = command
            .spawn()
            .map_err(|_| "Nessie Executor could not start its packaged command.".to_owned())?;
        self.connections.insert(
            executor_id.to_owned(),
            PendingConnection {
                child,
                started_at: Instant::now(),
            },
        );
        Ok("starting".to_owned())
    }

    fn start_daemon(&mut self, executor_id: &str) -> Result<String, String> {
        let state_dir = self.state_dir(executor_id)?;
        let mut command = self.command();
        command.args(serve_arguments(&state_dir));
        command.stdin(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|_| "Nessie Executor could not start the executor daemon.".to_owned())?;
        let parent_liveness = child
            .stdin
            .take()
            .ok_or_else(|| "Nessie Executor could not supervise the executor daemon.".to_owned())?;
        self.children.insert(
            executor_id.to_owned(),
            ManagedDaemon {
                child,
                parent_liveness: Some(parent_liveness),
            },
        );
        Ok("running".to_owned())
    }

    /// Starts desired executors whose retry delay has elapsed. The caller owns
    /// scheduling, so no network operation happens during SCM startup.
    pub fn recover_due(&mut self) -> Vec<(String, String)> {
        let now = Instant::now();
        let pending: Vec<String> = self.connections.keys().cloned().collect();
        let mut outcomes = Vec::new();
        for executor_id in pending {
            let outcome = self
                .connections
                .get_mut(&executor_id)
                .and_then(|connection| match connection.child.try_wait() {
                    Ok(Some(status)) => Some(status.code().unwrap_or(1) == 0),
                    Ok(None) if now.duration_since(connection.started_at) >= CONNECT_TIMEOUT => {
                        let _ = connection.child.kill();
                        Some(false)
                    }
                    Ok(None) | Err(_) => None,
                });
            let Some(connected) = outcome else {
                continue;
            };
            self.connections.remove(&executor_id);
            if connected {
                match self.start_daemon(&executor_id) {
                    Ok(_) => {
                        self.retry_after.remove(&executor_id);
                        outcomes.push((executor_id, "started".to_owned()));
                    }
                    Err(reason) => {
                        self.schedule_retry(&executor_id, Instant::now());
                        outcomes.push((executor_id, reason));
                    }
                }
            } else {
                self.schedule_retry(&executor_id, Instant::now());
                outcomes.push((executor_id, "could not connect; retry scheduled".to_owned()));
            }
        }
        let desired: Vec<String> = self.desired.iter().cloned().collect();
        for executor_id in &desired {
            let had_daemon = self.children.contains_key(executor_id);
            if had_daemon && self.child_status(executor_id) == "stopped" {
                self.children.remove(executor_id);
                self.schedule_retry(executor_id, now);
            }
        }
        let due: Vec<String> = desired
            .iter()
            .filter(|executor_id| {
                self.child_status(executor_id) == "stopped"
                    && !self.connections.contains_key(*executor_id)
                    && self
                        .retry_after
                        .get(*executor_id)
                        .map_or(true, |when| *when <= now)
            })
            .cloned()
            .collect();
        outcomes.extend(
            due.into_iter()
                .filter_map(|executor_id| match self.start_due(&executor_id) {
                    Ok(_) => Some((executor_id, "connecting".to_owned())),
                    Err(reason) => {
                        self.schedule_retry(&executor_id, now);
                        Some((executor_id, reason))
                    }
                })
                .collect::<Vec<_>>(),
        );
        outcomes
    }

    fn schedule_retry(&mut self, executor_id: &str, now: Instant) {
        let delay = self
            .retry_delay
            .entry(executor_id.to_owned())
            .or_insert(RETRY_INITIAL);
        let current = *delay;
        *delay = current.saturating_mul(2).min(RETRY_MAX);
        self.retry_after
            .insert(executor_id.to_owned(), now + current);
    }

    pub fn stop(&mut self, executor_id: &str) -> Result<String, String> {
        self.desired.remove(executor_id);
        self.retry_after.remove(executor_id);
        self.retry_delay.remove(executor_id);
        if let Some(mut connection) = self.connections.remove(executor_id) {
            let _ = connection.child.kill();
        }
        let Some(mut daemon) = self.children.remove(executor_id) else {
            return Ok("stopped".to_owned());
        };
        if daemon
            .child
            .try_wait()
            .map_err(|_| "Nessie Executor could not inspect the executor daemon.".to_owned())?
            .is_some()
        {
            return Ok("stopped".to_owned());
        }
        // Dropping the pipe closes the daemon's stdin, which is its shutdown
        // request. A second stop finds it already taken and is a no-op.
        daemon.parent_liveness.take();
        if wait_bounded(&mut daemon.child, STOP_TIMEOUT)?.is_some() {
            return Ok("stopped".to_owned());
        }
        self.children.insert(executor_id.to_owned(), daemon);
        Err(
            "The executor is still stopping. Nessie Executor will not force-kill a sandbox daemon."
                .to_owned(),
        )
    }

    /// Asks every daemon to stop, without waiting. The service reports
    /// `STOP_PENDING` while [`Self::still_running`] answers above zero.
    pub fn request_shutdown(&mut self) {
        for connection in self.connections.values_mut() {
            let _ = connection.child.kill();
        }
        self.connections.clear();
        self.desired.clear();
        self.retry_after.clear();
        self.retry_delay.clear();
        for daemon in self.children.values_mut() {
            daemon.parent_liveness.take();
        }
    }

    pub fn still_running(&mut self) -> usize {
        self.children
            .retain(|_, daemon| matches!(daemon.child.try_wait(), Ok(None)));
        self.children.len()
    }
}

#[cfg(test)]
#[path = "supervisor_tests.rs"]
mod supervisor_tests;
