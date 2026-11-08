//! Team names for the menu, the toasts and pause grouping, held in memory only.
//!
//! A name is read the way the console reads it: the pairing status of one
//! connection, which asks Nessie (backed by UOA) and can take seconds. One
//! pass runs at a time, a name that could not be read waits a minute before
//! it is asked again, and nothing is written anywhere: a restart reads names
//! afresh. A cached name never grants anything; it only labels a line.

use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use crate::{pipe_client::ServiceResponse, state::ExecutorStatus};

const RETRY: Duration = Duration::from_secs(60);

/// What Nessie says about one connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamIdentity {
    pub api_base_url: String,
    pub organization_name: String,
    /// `None` for a connection to a whole organisation rather than one team.
    pub team_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    Known(TeamIdentity),
    /// The captured owner proof needs renewing in Nessie before names can be read.
    OwnerConfirmation,
}

#[derive(Default)]
struct Cache {
    entries: BTreeMap<String, Entry>,
    retry_at: BTreeMap<String, Instant>,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);
static LOOKING: AtomicBool = AtomicBool::new(false);

pub fn snapshot() -> BTreeMap<String, Entry> {
    CACHE.lock().ok().and_then(|cache| cache.as_ref().map(|cache| cache.entries.clone())).unwrap_or_default()
}

pub fn identity_from(view: &serde_json::Value) -> Option<TeamIdentity> {
    Some(TeamIdentity {
        api_base_url: view.get("apiBaseUrl")?.as_str()?.to_owned(),
        organization_name: view.get("organizationName")?.as_str()?.to_owned(),
        team_name: view.get("teamName").and_then(serde_json::Value::as_str).map(str::to_owned),
    })
}

fn read(executor_id: &str) -> Result<Entry, ()> {
    match crate::pipe_client::call(&serde_json::json!({ "command": "pairingStatus", "executorId": executor_id })) {
        Ok(ServiceResponse::Pairing(view)) => identity_from(&view).map(Entry::Known).ok_or(()),
        Err(reason) if reason.contains("PAIRING_OWNER_CONFIRMATION_REQUIRED") => Ok(Entry::OwnerConfirmation),
        _ => Err(()),
    }
}

/// Reads the names this cache lacks, once per pass. Run off the main thread.
pub fn look_up(executors: &[ExecutorStatus]) {
    if LOOKING.swap(true, Ordering::AcqRel) {
        return;
    }
    let listed: Vec<String> = executors.iter().map(|executor| executor.executor_id.clone()).collect();
    let due: Vec<String> = match CACHE.lock() {
        Ok(mut guard) => {
            let cache = guard.get_or_insert_with(Cache::default);
            cache.entries.retain(|id, _| listed.contains(id));
            cache.retry_at.retain(|id, _| listed.contains(id));
            let now = Instant::now();
            listed.iter()
                .filter(|id| !matches!(cache.entries.get(*id), Some(Entry::Known(_))))
                .filter(|id| cache.retry_at.get(*id).is_none_or(|at| now >= *at))
                .cloned().collect()
        }
        Err(_) => Vec::new(),
    };
    for id in due {
        let entry = read(&id);
        if let Ok(mut guard) = CACHE.lock() {
            let cache = guard.get_or_insert_with(Cache::default);
            match entry {
                Ok(Entry::Known(identity)) => {
                    cache.entries.insert(id.clone(), Entry::Known(identity));
                    cache.retry_at.remove(&id);
                }
                Ok(other) => {
                    cache.entries.insert(id.clone(), other);
                    cache.retry_at.insert(id, Instant::now() + RETRY);
                }
                Err(()) => {
                    cache.retry_at.insert(id, Instant::now() + RETRY);
                }
            }
        }
    }
    LOOKING.store(false, Ordering::Release);
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
/// different servers would otherwise read the same. A connection whose name is
/// not known yet reads as `unknown`, never as its id.
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
    use super::{identity_from, label, same_team, TeamIdentity};

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
    fn a_pairing_status_answer_carries_the_names_and_the_server() {
        let view = serde_json::json!({
            "status": "paired", "apiBaseUrl": "https://api.nessie.works", "executorId": "a-1",
            "machineName": "DESK", "organizationName": "Acme", "teamName": "Sales",
        });
        assert_eq!(identity_from(&view), Some(identity("https://api.nessie.works", "Acme", Some("Sales"))));
        let organisation = serde_json::json!({ "apiBaseUrl": "https://x.example", "organizationName": "Acme",
            "teamName": null });
        assert_eq!(identity_from(&organisation).unwrap().team_name, None);
        assert_eq!(identity_from(&serde_json::json!({ "status": "waiting" })), None);
    }
}
