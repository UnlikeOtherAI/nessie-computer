//! Team names for the menu, the window, the toasts and pause grouping.
//!
//! Every team keeps a display-only label in its own folder
//! (`docs/team-names.md`). Status rows carry it: the service reads its teams'
//! labels and this app reads its own (`ExecutorStatus::names`), so naming a
//! team costs no request of anyone. This module remembers the last name each
//! listed connection had, so a row that comes back without one never blanks a
//! known name, and it asks Nessie for this account's teams' names in one
//! `team-names` call when the app starts and every hour; the service does the
//! same for the teams it holds. A name never grants anything; it only labels
//! a line.

use std::{collections::BTreeMap, process::Stdio, sync::Mutex, time::Duration};

use nessie_windows_common::team_label::{
    collect_team_names_failures, team_names_arguments, TeamLabel, TEAM_NAMES_REFRESH_SECONDS,
};

use crate::state::ExecutorStatus;

/// What a connection's team is called and which server said so.
pub type TeamIdentity = TeamLabel;

static NAMES: Mutex<BTreeMap<String, TeamIdentity>> = Mutex::new(BTreeMap::new());

/// Takes the names the latest rows carry and gives every row the last name
/// its connection had: a known name stays until the connection is gone.
pub fn remember(executors: &mut [ExecutorStatus]) {
    let Ok(mut names) = NAMES.lock() else { return };
    names.retain(|id, _| executors.iter().any(|executor| &executor.executor_id == id));
    for executor in executors.iter_mut() {
        match &executor.names {
            Some(label) => { names.insert(executor.executor_id.clone(), label.clone()); }
            None => executor.names = names.get(&executor.executor_id).cloned(),
        }
    }
}

/// The names last seen, by connection.
pub fn snapshot() -> BTreeMap<String, TeamIdentity> {
    NAMES.lock().map(|names| names.clone()).unwrap_or_default()
}

/// Asks Nessie for the names of the teams this app runs under the person's
/// account, now and every hour, on a thread of its own: Nessie can take
/// seconds, and a failure changes nothing on disk. What went wrong is written
/// to this app's log, one line each, as its other diagnostics are.
pub fn refresh_hourly() {
    std::thread::spawn(|| loop {
        if let Some(arguments) = team_names_arguments(&crate::user_connections::state_dirs()) {
            match run_team_names(&arguments) {
                Ok(failures) => failures.iter().for_each(|failure| eprintln!("Nessie Computer: {failure}")),
                Err(reason) => eprintln!("Nessie Computer: team names were not refreshed. {reason}"),
            }
        }
        std::thread::sleep(Duration::from_secs(TEAM_NAMES_REFRESH_SECONDS));
    });
}

/// One `team-names` call, answering the failures it printed on standard error.
fn run_team_names(arguments: &[String]) -> Result<Vec<String>, String> {
    let mut command = crate::user_runtime::command()?;
    let mut child = command.args(arguments).stderr(Stdio::piped()).spawn()
        .map_err(|_| "Could not start Nessie Computer’s command-line tool.".to_owned())?;
    let errors = child.stderr.take().map(collect_team_names_failures);
    match crate::user_runtime::wait(&mut child, Duration::from_secs(120)) {
        Ok(true) => {}
        Ok(false) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("The command-line tool did not answer in time.".to_owned());
        }
        Err(reason) => return Err(reason),
    }
    Ok(errors.and_then(|reader| reader.join().ok()).unwrap_or_default())
}

/// Several connections can serve one team on this computer — the one this app
/// runs and the service's ChatGPT plan connection. They are one team when
/// Nessie names the same server, organisation and team for both.
pub fn same_team(left: &TeamIdentity, right: &TeamIdentity) -> bool {
    left == right
}

fn server_host(api_base_url: &str) -> String {
    url::Url::parse(api_base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_else(|| api_base_url.to_owned())
}

fn base_label(identity: &TeamIdentity) -> String {
    match &identity.team_name {
        Some(team) => format!("{team} · {}", identity.organization_name),
        None => identity.organization_name.clone(),
    }
}

/// `{teamName} · {organizationName}`, with ` ({serverHost})` when two teams on
/// different servers would otherwise read the same. A connection whose team
/// has never had a name reads as `unknown`, never as its id.
pub fn label(identity: Option<&TeamIdentity>, all: &[&TeamIdentity], unknown: &str) -> String {
    let Some(identity) = identity else {
        return unknown.to_owned();
    };
    let base = base_label(identity);
    let clash = all.iter().any(|other| {
        !same_team(other, identity) && base_label(other) == base
    });
    if clash {
        format!("{base} ({})", server_host(&identity.api_base_url))
    } else {
        base
    }
}

#[cfg(test)]
mod tests {
    use super::{label, remember, same_team, snapshot, TeamIdentity};
    use crate::state::tests::executor;

    fn identity(api: &str, organization: &str, team: Option<&str>) -> TeamIdentity {
        TeamIdentity {
            api_base_url: api.to_owned(),
            organization_name: organization.to_owned(),
            team_name: team.map(str::to_owned),
        }
    }

    #[test]
    fn a_team_reads_as_team_then_organisation_and_never_as_an_id() {
        let sales = identity("https://api.nessie.works", "Acme", Some("Sales"));
        assert_eq!(label(Some(&sales), &[&sales], "Team name not available yet"), "Sales · Acme");
        let whole = identity("https://api.nessie.works", "Acme", None);
        assert_eq!(label(Some(&whole), &[&whole], "?"), "Acme");
        assert_eq!(label(None, &[], "Team name not available yet"), "Team name not available yet");
    }

    #[test]
    fn equal_labels_on_different_servers_name_their_server() {
        let hosted = identity("https://api.nessie.works", "Acme", Some("Sales"));
        let own = identity("https://nessie.acme.example", "Acme", Some("Sales"));
        assert_eq!(label(Some(&hosted), &[&hosted, &own], "?"), "Sales · Acme (api.nessie.works)");
        assert_eq!(label(Some(&own), &[&hosted, &own], "?"), "Sales · Acme (nessie.acme.example)");
        // Two connections to the very same team are one team, not a clash.
        let plans = hosted.clone();
        assert!(same_team(&hosted, &plans));
        assert_eq!(label(Some(&hosted), &[&hosted, &plans], "?"), "Sales · Acme");
    }

    #[test]
    fn a_known_name_survives_a_row_without_one_and_leaves_with_its_connection() {
        let sales = identity("https://api.nessie.works", "Acme", Some("Sales"));
        let mut named = executor("remember-a", "running", false);
        named.names = Some(sales.clone());
        let mut rows = vec![named, executor("remember-b", "running", false)];
        remember(&mut rows);
        assert_eq!(rows[1].names, None, "a team that never had a name has none");
        // The next poll's row lost its label (an unreadable file): the known name stays.
        let mut later = vec![executor("remember-a", "running", false)];
        remember(&mut later);
        assert_eq!(later[0].names.as_ref(), Some(&sales));
        // A renamed team takes its new name.
        let renamed = identity("https://api.nessie.works", "Acme", Some("Revenue"));
        let mut next = executor("remember-a", "running", false);
        next.names = Some(renamed.clone());
        remember(&mut [next]);
        assert_eq!(snapshot().get("remember-a"), Some(&renamed));
        remember(&mut []);
        assert!(!snapshot().contains_key("remember-a"), "a disconnected team is forgotten");
    }
}
