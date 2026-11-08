//! User-session connections share the CLI's owner-only state and never read its keys.
//! Existing Windows service connections still use their authenticated control pipe.
use std::{
    collections::BTreeMap, fs, path::PathBuf, process::{Child, ChildStdin, Stdio},
    sync::{Mutex, OnceLock}, time::{Duration, Instant},
};
use nessie_windows_common::{
    failure::{classify, retriable, Failure, StderrTail}, lease::unowned_daemon_is_stopping,
    owner_controls::{read_paused, Answer, RequestCache}, unpair,
};
use crate::{pipe_client::ServiceResponse, state::{Connection, ExecutorStatus}, user_owner, user_runtime};

/// A daemon this app started. Its liveness pipe is taken only when the person
/// stops it, so a daemon that has exited with the pipe still held stopped on
/// its own, and the last line it wrote to standard error says why.
struct Daemon { child: Child, liveness: Option<ChildStdin>, started_at: Instant, stderr: StderrTail }
#[derive(Default)]
struct Connections {
    daemons: BTreeMap<String, Daemon>,
    /// Why each connection last stopped on its own, until it is started again.
    failures: BTreeMap<String, Failure>,
    requests: BTreeMap<String, RequestCache>,
    /// When each connection that stopped on its own is next started.
    restart_at: BTreeMap<String, Instant>,
    /// The wait before the next restart of each connection.
    restart_delay: BTreeMap<String, Duration>,
}
static CONNECTIONS: OnceLock<Mutex<Connections>> = OnceLock::new();

/// The same waits the Windows service uses for its own connections.
const RESTART_INITIAL: Duration = Duration::from_secs(5);
const RESTART_MAX: Duration = Duration::from_secs(300);

/// How long an exited daemon's last words may take to arrive through its pipe.
const STDERR_SETTLE: Duration = Duration::from_millis(500);

/// The wait before starting a connection that stopped on its own, and the wait
/// after that: it doubles from five seconds to five minutes, and a connection
/// that stayed up for the longest wait starts over at the shortest.
fn restart_waits(previous: Option<Duration>, ran: Duration) -> (Duration, Duration) {
    let wait = if ran >= RESTART_MAX { RESTART_INITIAL } else { previous.unwrap_or(RESTART_INITIAL) };
    (wait, wait.saturating_mul(2).min(RESTART_MAX))
}

/// A connection another app or CLI runs. This app neither starts nor stops it.
pub const RUNNING_ELSEWHERE: &str = "running elsewhere";

fn root() -> Result<PathBuf, String> {
    Ok(PathBuf::from(std::env::var_os("USERPROFILE").ok_or("Windows reported no user profile.")?)
        .join(".local/state/nessie-executor"))
}

pub(crate) fn directory(id: &str) -> Result<PathBuf, String> {
    if id.len() != 36 || !id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') {
        return Err("Invalid team identity.".into());
    }
    Ok(root()?.join(id))
}

pub fn owns(id: &str) -> bool {
    directory(id).is_ok_and(|path| {
        [path.clone(), path.join("executor-state.json")].iter().enumerate().all(|(index, entry)| {
            fs::symlink_metadata(entry).is_ok_and(|meta| !meta.file_type().is_symlink()
                && if index == 0 { meta.is_dir() } else { meta.is_file() })
        })
    })
}

fn ids() -> Result<Vec<String>, String> {
    let entries = match fs::read_dir(root()?) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Could not list this account's paired teams.".into()),
    };
    let mut ids: Vec<_> = entries.filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned()).filter(|id| owns(id)).collect();
    ids.sort();
    Ok(ids)
}

impl Connections {
    fn statuses(&mut self) -> Result<Vec<ExecutorStatus>, String> {
        ids()?.into_iter().map(|id| {
            let state_dir = directory(&id)?;
            let state = if let Some(daemon) = self.daemons.get_mut(&id) {
                match daemon.child.try_wait().map_err(|_| "Could not inspect this team's connection.")? {
                    None if daemon.liveness.is_some() => "running",
                    None => "stopping",
                    Some(_) => {
                        if daemon.liveness.is_some() && !self.failures.contains_key(&id) {
                            let reason = daemon.stderr.settled(STDERR_SETTLE)
                                .unwrap_or_else(|| "This team's connection stopped.".to_owned());
                            self.failures.insert(id.clone(), classify(&reason));
                        }
                        "stopped"
                    }
                }
            } else if unowned_daemon_is_stopping(&state_dir) { RUNNING_ELSEWHERE } else { "stopped" };
            let mut requests = self.requests.remove(&id).unwrap_or_default();
            requests.refresh(&state_dir, Instant::now(), || user_owner::program_requests(&state_dir));
            let pending_program_requests = requests.requests().len();
            self.requests.insert(id.clone(), requests);
            Ok(ExecutorStatus {
                failure: (state == "stopped").then(|| self.failures.get(&id).cloned()).flatten(),
                paused: read_paused(&state_dir),
                pending_program_requests,
                connection: Connection::User,
                chatgpt_connection_id: None,
                executor_id: id,
                daemon_status: state.into(),
                workspace_configured: true,
            })
        }).collect()
    }

    fn start(&mut self, id: &str) -> Result<(), String> {
        if !owns(id) { return Err("This team is not paired under this account.".into()); }
        if let Some(daemon) = self.daemons.get_mut(id) {
            if daemon.child.try_wait().map_err(|error| error.to_string())?.is_none() {
                return if daemon.liveness.is_some() { Ok(()) } else { Err("This team is still stopping.".into()) };
            }
        }
        let state_dir = directory(id)?;
        if unowned_daemon_is_stopping(&state_dir) {
            return Err("This connection is running in another app or CLI. Stop it there first.".into());
        }
        let path = state_dir.display().to_string();
        // serve claims its own connection. Never block the tray's controller
        // on a preliminary network request while the user is signing in.
        let mut child = user_runtime::command()?.args(["serve", "--parent-liveness-stdin", "--state-dir", &path])
            .stdin(Stdio::piped()).stderr(Stdio::piped()).spawn()
            .map_err(|_| "Could not start this team's connection.")?;
        let liveness = child.stdin.take();
        let stderr = child.stderr.take().map(StderrTail::watch).unwrap_or_default();
        self.daemons.insert(id.into(), Daemon { child, liveness, started_at: Instant::now(), stderr });
        self.failures.remove(id);
        self.restart_at.remove(id);
        Ok(())
    }

    /// Starts again each connection this app started that stopped without
    /// being asked to, once its wait is over, unless it stopped for a reason a
    /// restart cannot fix. With the setting off they stay stopped until the
    /// owner applies a remedy.
    fn restart_stopped(&mut self, enabled: bool, now: Instant) {
        let stopped: Vec<(String, Instant, Option<String>)> = self.daemons.iter_mut()
            .filter_map(|(id, daemon)| {
                let exited = daemon.liveness.is_some() && matches!(daemon.child.try_wait(), Ok(Some(_)));
                exited.then(|| (id.clone(), daemon.started_at, daemon.stderr.settled(STDERR_SETTLE)))
            })
            .collect();
        for (id, started_at, reason) in stopped {
            // A recognised refusal is never retried: it waits for the owner's remedy.
            let failure = classify(reason.as_deref().unwrap_or("This team's connection stopped."));
            if !retriable(&failure) {
                self.failures.insert(id.clone(), failure);
                self.restart_at.remove(&id);
                continue;
            }
            if !enabled {
                self.restart_at.remove(&id);
                continue;
            }
            if !self.restart_at.contains_key(&id) {
                let (wait, next) = restart_waits(self.restart_delay.get(&id).copied(), now.duration_since(started_at));
                self.restart_delay.insert(id.clone(), next);
                self.restart_at.insert(id.clone(), now + wait);
            }
            if self.restart_at.get(&id).is_some_and(|due| now >= *due) {
                self.restart_at.remove(&id);
                // A failed start leaves the stopped daemon in place, so the
                // next poll schedules another attempt after a longer wait;
                // the attempt counts as a start, or a connection that fails
                // for five minutes would be retried at the shortest wait.
                if let Err(reason) = self.start(&id) {
                    eprintln!("Nessie Computer could not restart team {id}: {reason}");
                    if let Some(daemon) = self.daemons.get_mut(&id) { daemon.started_at = now; }
                }
            }
        }
    }

    fn stop(&mut self, id: &str) -> Result<(), String> {
        self.failures.remove(id);
        self.restart_at.remove(id);
        self.restart_delay.remove(id);
        let Some(daemon) = self.daemons.get_mut(id) else {
            return if unowned_daemon_is_stopping(&directory(id)?) {
                Err("Stop this connection in the app or CLI that started it.".into())
            } else { Ok(()) };
        };
        daemon.liveness.take();
        // Never kill a daemon whose guests may still be tearing down.
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while daemon.child.try_wait().map_err(|error| error.to_string())?.is_none() {
            if std::time::Instant::now() >= deadline { return Err("This team is still stopping. Try again shortly.".into()); }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.daemons.remove(id);
        Ok(())
    }

    /// The console already asked the person, so there is no dialog here. The
    /// CLI refuses while any daemon holds the connection, signs off with Nessie
    /// (best effort) and deletes the state directory. A removal that fails
    /// leaves the connection stopped rather than restarting what the person
    /// asked to remove; Start brings it back.
    fn remove(&mut self, id: &str) -> Result<bool, String> {
        if !owns(id) { return Err("This team is not paired on this computer.".into()); }
        self.stop(id)?;
        let state_dir = directory(id)?;
        let signed_off = unpair::signed_off(&user_runtime::run(&unpair::unpair_arguments(&state_dir), None)?)?;
        if owns(id) { return Err("The team was disconnected but its settings are still here.".into()); }
        self.daemons.remove(id);
        // No state file means no connection; an empty folder left behind would
        // only confuse a person browsing the state root. Anything else in it is
        // not this app's to delete.
        match fs::remove_dir(&state_dir) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => eprintln!("Nessie Computer removed team {id}; its folder still holds files it did not create."),
        }
        Ok(signed_off)
    }

    fn request(&mut self, request: &serde_json::Value) -> Result<ServiceResponse, String> {
        let command = request["command"].as_str().ok_or("Missing command.")?;
        let id = request["executorId"].as_str();
        match command {
            "status" => Ok(ServiceResponse::Status(self.statuses()?)),
            "start" | "stop" => {
                let id = id.ok_or("Select a paired team.")?;
                if command == "start" { self.start(id)?; } else { self.stop(id)?; }
                Ok(ServiceResponse::Status(self.statuses()?))
            }
            "remove" => Ok(ServiceResponse::Removed { signed_off: self.remove(id.ok_or("Select a paired team.")?)? }),
            "inferenceConnections" => {
                let id = id.ok_or("Select a paired team.")?;
                if !owns(id) { return Err("This team is not paired under this account.".into()); }
                let operation = nessie_windows_common::inference_control::validate(request["operation"].clone())?;
                let path = directory(id)?.display().to_string();
                Ok(ServiceResponse::InferenceConnections(user_runtime::run(
                    &["local-inference".into(), "connections".into(), "--operation-stdin".into(),
                        "--state-dir".into(), path], Some(&operation))?))
            }
            "describe" | "configureInput" => {
                let id = id.ok_or("Select a paired team.")?;
                let path = directory(id)?.display().to_string();
                if !owns(id) { return Err("This team is not paired under this account.".into()); }
                if command == "configureInput" {
                    // Applied live: the CLI writes the next revision and tells
                    // the running daemon, which keeps its connection.
                    user_runtime::run(&["configure".into(), "--configuration-input-stdin".into(),
                        "--state-dir".into(), path.clone()], Some(&request["configurationInput"]))?;
                }
                Ok(ServiceResponse::Describe(user_runtime::run(
                    &["describe".into(), "--state-dir".into(), path], None)?))
            }
            "setPaused" | "programRequests" | "answerProgramRequest" | "audience" => {
                let id = id.ok_or("Select a paired team.")?;
                if !owns(id) { return Err("This team is not paired under this account.".into()); }
                let state_dir = directory(id)?;
                match command {
                    "setPaused" => {
                        user_owner::set_paused(&state_dir, request["paused"].as_bool().ok_or("Choose Pause or Resume.")?)?;
                        Ok(ServiceResponse::Status(self.statuses()?))
                    }
                    "audience" => Ok(ServiceResponse::Audience(user_owner::audience(&state_dir)?)),
                    _ => {
                        let requests = if command == "programRequests" {
                            user_owner::program_requests(&state_dir)?
                        } else {
                            let answer = Answer::parse(request["answer"].as_str().unwrap_or(""))?;
                            user_owner::answer(&state_dir, request["id"].as_str().unwrap_or(""), answer)?
                        };
                        self.requests.entry(id.to_owned()).or_default().replace(requests.clone(), Instant::now());
                        Ok(ServiceResponse::ProgramRequests(requests))
                    }
                }
            }
            "pairingStart" | "pairingStatus" | "pairingCancel" => {
                let cli = match command {
                    "pairingStart" => "pairing-start", "pairingCancel" => "pairing-cancel", _ => "pairing-status",
                };
                let mut args = vec![cli.into(), "--json".into()];
                if let Some(id) = id { args.extend(["--executor".into(), id.into()]); }
                let input = if command == "pairingStart" {
                    args.extend(["--api".into(), request["apiBaseUrl"].as_str().ok_or("Choose a server.")?.into(),
                        "--pairing-input-stdin".into()]);
                    // No folder named: the runtime grants its defaults, a
                    // `Nessie` folder in the home directory and `%PUBLIC%`.
                    Some(serde_json::json!({}))
                } else { None };
                let view = user_runtime::run(&args, input.as_ref())?;
                // The claim in Nessie completed the pairing: the status check of the
                // open attempt that first reads `paired` starts its daemon. It is
                // paired even if the network drops before the daemon can connect.
                if command == "pairingStatus" && id.is_none() && view["status"] == "paired" {
                    if let Some(id) = view["executorId"].as_str() { let _ = self.start(id); }
                }
                Ok(ServiceResponse::Pairing(view))
            }
            _ => Err("Unsupported command.".into()),
        }
    }
}

pub fn call(request: &serde_json::Value) -> Result<ServiceResponse, String> {
    CONNECTIONS.get_or_init(|| Mutex::new(Connections::default())).lock()
        .map_err(|_| "Could not reach this app’s connections.")?.request(request)
}

pub fn start_paired() {
    std::thread::spawn(|| {
        if let Ok(mut connections) = CONNECTIONS.get_or_init(|| Mutex::new(Connections::default())).lock() {
            for id in ids().unwrap_or_default() { let _ = connections.start(&id); }
        }
    });
}

/// Called on every tray poll. A setting that cannot be read counts as on: it
/// is on unless the person turned it off.
pub fn restart_stopped() {
    let enabled = crate::restart_setting::enabled().unwrap_or(true);
    if let Ok(mut connections) = CONNECTIONS.get_or_init(|| Mutex::new(Connections::default())).lock() {
        connections.restart_stopped(enabled, Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::{restart_waits, RESTART_INITIAL, RESTART_MAX};
    use std::time::Duration;

    #[test]
    fn a_connection_that_keeps_stopping_waits_longer_each_time_up_to_five_minutes() {
        let ran = Duration::from_secs(1);
        let (first, next) = restart_waits(None, ran);
        assert_eq!((first, next), (RESTART_INITIAL, Duration::from_secs(10)));
        let (second, next) = restart_waits(Some(next), ran);
        assert_eq!((second, next), (Duration::from_secs(10), Duration::from_secs(20)));
        let (longest, next) = restart_waits(Some(Duration::from_secs(240)), ran);
        assert_eq!((longest, next), (Duration::from_secs(240), RESTART_MAX));
        assert_eq!(restart_waits(Some(RESTART_MAX), ran), (RESTART_MAX, RESTART_MAX));
    }

    #[test]
    fn a_connection_that_stayed_up_for_the_longest_wait_starts_over() {
        assert_eq!(restart_waits(Some(RESTART_MAX), RESTART_MAX), (RESTART_INITIAL, Duration::from_secs(10)));
    }
}
