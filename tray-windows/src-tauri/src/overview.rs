//! What the menu and the icon say, decided from the view as one pure function,
//! by the same rules as the macOS menu bar (`ComputerMenuModel`).
//!
//! Connections are grouped into teams first: the connection this app runs and
//! the service's ChatGPT plan connection to the same team are one line, one
//! pause and one count. Each team then has at most one thing only its owner
//! can settle; one such thing is named, several read "N things".

use std::collections::BTreeMap;

use crate::{
    menu::ConsoleSection,
    state::{ExecutorStatus, ServiceView},
    sync_status::{SyncLine, SyncOverview},
    team_names::{label, same_team, Entry, TeamIdentity},
    words::{fill, Locale, Words},
};

/// One team on this computer and every connection that serves it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Team {
    pub executor_ids: Vec<String>,
    pub label: String,
    /// Every connection of the team is paused.
    pub paused: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Activity {
    Working,
    Paused,
    Connecting,
    NotConnected,
}

/// Why a team needs its owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Programs(usize),
    DocumentConflicts(u64),
    CheckDocuments,
    AllowDocuments,
    AllowDocumentsAgain,
    FolderMissing,
    DiskFull,
    NotConnected,
}

/// The one "Needs you" line, and the place it opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeedsYou {
    pub text: String,
    pub section: ConsoleSection,
    pub executor_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overview {
    pub status: String,
    pub needs_you: Option<NeedsYou>,
    pub teams: Vec<Team>,
}

fn identity<'a>(names: &'a BTreeMap<String, Entry>, executor_id: &str) -> Option<&'a TeamIdentity> {
    match names.get(executor_id) {
        Some(Entry::Known(identity)) => Some(identity),
        _ => None,
    }
}

/// Connections grouped by the team Nessie names for them, in list order. A
/// connection whose name is not known yet is a team of its own.
pub fn group<'a>(executors: &'a [ExecutorStatus], names: &BTreeMap<String, Entry>) -> Vec<Vec<&'a ExecutorStatus>> {
    let mut groups: Vec<Vec<&ExecutorStatus>> = Vec::new();
    for executor in executors {
        let mine = identity(names, &executor.executor_id);
        let existing = mine.and_then(|mine| groups.iter_mut().find(|group| {
            identity(names, &group[0].executor_id).is_some_and(|theirs| same_team(mine, theirs))
        }));
        match existing {
            Some(group) => group.push(executor),
            None => groups.push(vec![executor]),
        }
    }
    groups
}

fn activity(team: &[&ExecutorStatus]) -> Activity {
    if team.iter().all(|executor| executor.paused) {
        Activity::Paused
    } else if team.iter().any(|executor| executor.working()) {
        Activity::Working
    } else if team.iter().any(|executor| !executor.paused && executor.daemon_status == "starting") {
        Activity::Connecting
    } else {
        Activity::NotConnected
    }
}

/// A failure the supervisors will not heal by retrying: a fenced connection,
/// a rejected key, a stale revision, an unconfirmed pairing.
fn needs_owner(executor: &ExecutorStatus) -> bool {
    executor.failure.as_ref()
        .and_then(|failure| failure.code.as_deref())
        .is_some_and(|code| code != "EXECUTOR_API_TIMEOUT")
}

fn documents_reason(line: SyncLine) -> Option<Reason> {
    match line {
        SyncLine::Conflicts(count) => Some(Reason::DocumentConflicts(count)),
        SyncLine::NeedsAttention => Some(Reason::CheckDocuments),
        SyncLine::AllowInNessie => Some(Reason::AllowDocuments),
        SyncLine::AllowAgainInNessie => Some(Reason::AllowDocumentsAgain),
        SyncLine::FolderMissing => Some(Reason::FolderMissing),
        SyncLine::DiskFull => Some(Reason::DiskFull),
        _ => None,
    }
}

fn team_reason(team: &[&ExecutorStatus], sync: Option<&SyncOverview>) -> Option<Reason> {
    let programs: usize = team.iter().map(|executor| executor.pending_program_requests).sum();
    if programs > 0 {
        return Some(Reason::Programs(programs));
    }
    let running = team.iter().any(|executor| executor.daemon_status == "running");
    let connecting = team.iter().any(|executor| executor.daemon_status == "starting");
    if !running && !connecting && team.iter().any(|executor| !executor.paused && needs_owner(executor)) {
        return Some(Reason::NotConnected);
    }
    sync.filter(|overview| team.iter().any(|executor| executor.executor_id == overview.executor_id))
        .and_then(|overview| documents_reason(overview.line))
}

fn say(reason: Reason, words: &Words, locale: Locale) -> String {
    match reason {
        Reason::Programs(count) => words.reason_programs.pick(locale, count),
        Reason::DocumentConflicts(count) => words.reason_conflicts.pick(locale, count as usize),
        Reason::CheckDocuments => words.reason_check_documents.to_owned(),
        Reason::AllowDocuments => words.reason_allow_documents.to_owned(),
        Reason::AllowDocumentsAgain => words.reason_allow_documents_again.to_owned(),
        Reason::FolderMissing => words.reason_folder_missing.to_owned(),
        Reason::DiskFull => words.reason_disk_full.to_owned(),
        Reason::NotConnected => words.reason_not_connected.to_owned(),
    }
}

fn status(activities: &[Activity], words: &Words, locale: Locale) -> String {
    let working = activities.iter().filter(|activity| **activity == Activity::Working).count();
    let paused = activities.iter().filter(|activity| **activity == Activity::Paused).count();
    if activities.is_empty() {
        words.status_no_team.to_owned()
    } else if paused == activities.len() {
        words.status_paused.to_owned()
    } else if working > 0 {
        let mut parts = vec![words.working.pick(locale, working)];
        if paused > 0 {
            parts.push(words.paused_part.pick(locale, paused));
        }
        let not_connected = activities.len() - working - paused;
        if not_connected > 0 {
            parts.push(words.not_connected_part.pick(locale, not_connected));
        }
        parts.join(" · ")
    } else if activities.contains(&Activity::Connecting) {
        words.status_connecting.to_owned()
    } else {
        words.status_not_connected.to_owned()
    }
}

pub fn build(
    view: &ServiceView,
    names: &BTreeMap<String, Entry>,
    sync: Option<&SyncOverview>,
    words: &Words,
    locale: Locale,
) -> Overview {
    let ServiceView::Reachable { executors } = view else {
        return Overview { status: words.service_unreachable.to_owned(), needs_you: None, teams: Vec::new() };
    };
    let identities: Vec<&TeamIdentity> = executors.iter()
        .filter_map(|executor| identity(names, &executor.executor_id)).collect();
    let label_of = |executor_id: &str| label(identity(names, executor_id), &identities, words.team_unavailable);
    let groups = group(executors, names);
    let teams: Vec<Team> = groups.iter().map(|connections| Team {
        executor_ids: connections.iter().map(|executor| executor.executor_id.clone()).collect(),
        label: label_of(&connections[0].executor_id),
        paused: connections.iter().all(|executor| executor.paused),
    }).collect();
    let activities: Vec<Activity> = groups.iter().map(|team| activity(team)).collect();

    let mut items: Vec<NeedsYou> = Vec::new();
    if executors.iter().any(|executor| matches!(names.get(&executor.executor_id), Some(Entry::OwnerConfirmation))) {
        items.push(NeedsYou { text: words.needs_you_unreadable.to_owned(), section: ConsoleSection::Overview,
            executor_id: None });
    }
    for (team, connections) in teams.iter().zip(&groups) {
        let Some(reason) = team_reason(connections, sync) else { continue };
        let (section, executor_id) = match (reason, sync) {
            (Reason::Programs(_) | Reason::NotConnected, _) | (_, None) => {
                (ConsoleSection::Overview, team.executor_ids[0].clone())
            }
            // Documents belong to the connection sync reported them for.
            (_, Some(overview)) => (ConsoleSection::Documents, overview.executor_id.clone()),
        };
        items.push(NeedsYou {
            text: fill(words.needs_you, &[("team", &team.label), ("reason", &say(reason, words, locale))]),
            section,
            executor_id: Some(executor_id),
        });
    }
    let needs_you = if items.len() > 1 {
        Some(NeedsYou { text: words.needs_you_many.pick(locale, items.len()), section: ConsoleSection::Overview,
            executor_id: None })
    } else {
        items.pop()
    };
    Overview { status: status(&activities, words, locale), needs_you, teams }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use nessie_windows_common::failure::classify;

    use super::{build, NeedsYou};
    use crate::{
        menu::ConsoleSection,
        state::{tests::executor, Connection, ExecutorStatus, ServiceView},
        sync_status::{SyncLine, SyncOverview},
        team_names::{Entry, TeamIdentity},
        words::{table, Locale},
    };

    fn named(pairs: &[(&str, &str)]) -> BTreeMap<String, Entry> {
        pairs.iter().map(|(id, team)| ((*id).to_owned(), Entry::Known(TeamIdentity {
            api_base_url: "https://api.nessie.works".to_owned(),
            organization_name: "Acme".to_owned(),
            team_name: Some((*team).to_owned()),
        }))).collect()
    }

    fn english(view: &ServiceView, names: &BTreeMap<String, Entry>, sync: Option<&SyncOverview>) -> super::Overview {
        build(view, names, sync, table(Locale::EnGb), Locale::EnGb)
    }

    fn reachable(executors: Vec<ExecutorStatus>) -> ServiceView {
        ServiceView::Reachable { executors }
    }

    #[test]
    fn the_status_sentence_counts_teams_not_connections() {
        let mut plans = executor("plans", "running", false);
        plans.connection = Connection::Service;
        let view = reachable(vec![executor("sales", "running", false), plans, executor("ops", "running", false)]);
        let names = named(&[("sales", "Sales"), ("plans", "Sales"), ("ops", "Ops")]);
        let overview = english(&view, &names, None);
        assert_eq!(overview.status, "Working for 2 teams");
        assert_eq!(overview.teams.len(), 2);
        assert_eq!(overview.teams[0].executor_ids, ["sales", "plans"]);
        assert_eq!(overview.teams[0].label, "Sales · Acme");
        assert_eq!(overview.needs_you, None);
    }

    #[test]
    fn each_state_has_the_same_sentence_as_on_macos() {
        let names = BTreeMap::new();
        let sentence = |executors| english(&reachable(executors), &names, None).status;
        assert_eq!(sentence(vec![]), "No team connected");
        assert_eq!(sentence(vec![executor("a", "running", true), executor("b", "stopped", true)]), "Paused");
        assert_eq!(sentence(vec![executor("a", "starting", false)]), "Connecting…");
        assert_eq!(sentence(vec![executor("a", "stopped", false)]), "Not connected — open Nessie Computer");
        assert_eq!(sentence(vec![executor("a", "running", false), executor("b", "running", true),
            executor("c", "stopped", false)]), "Working for 1 team · 1 paused · 1 not connected");
        let down = ServiceView::Unreachable { reason: "the service could not be reached".to_owned() };
        assert_eq!(english(&down, &names, None).status, "Can’t reach the Nessie Computer service");
    }

    #[test]
    fn one_thing_names_its_team_and_opens_its_place() {
        let names = named(&[("a", "Sales"), ("b", "Ops")]);
        let mut asking = executor("a", "running", false);
        asking.pending_program_requests = 2;
        assert_eq!(english(&reachable(vec![asking, executor("b", "running", false)]), &names, None).needs_you,
            Some(NeedsYou { text: "Needs you: Sales · Acme — 2 programs ask to run".to_owned(),
                section: ConsoleSection::Overview, executor_id: Some("a".to_owned()) }));
        let documents = SyncOverview { executor_id: "b".to_owned(), line: SyncLine::Conflicts(1) };
        let quiet = reachable(vec![executor("a", "running", false), executor("b", "running", false)]);
        assert_eq!(english(&quiet, &names, Some(&documents)).needs_you,
            Some(NeedsYou { text: "Needs you: Ops · Acme — 1 document conflict".to_owned(),
                section: ConsoleSection::Documents, executor_id: Some("b".to_owned()) }));
        let mut fenced = executor("b", "stopped", false);
        fenced.failure = Some(classify("Executor connection is fenced."));
        assert_eq!(english(&reachable(vec![executor("a", "running", false), fenced]), &names, None)
            .needs_you.unwrap().text, "Needs you: Ops · Acme — not connected");
    }

    #[test]
    fn several_things_are_counted_and_open_overview() {
        let mut names = named(&[("a", "Sales")]);
        names.insert("b".to_owned(), Entry::OwnerConfirmation);
        let mut asking = executor("a", "running", false);
        asking.pending_program_requests = 1;
        let overview = english(&reachable(vec![asking, executor("b", "running", false)]), &names, None);
        assert_eq!(overview.needs_you, Some(NeedsYou { text: "Needs you: 2 things — open Nessie Computer".to_owned(),
            section: ConsoleSection::Overview, executor_id: None }));
        let unreadable = english(&reachable(vec![executor("b", "running", false)]), &names, None);
        assert_eq!(unreadable.needs_you.unwrap().text, "Needs you: a team on this computer can’t be read");
    }

    #[test]
    fn a_failure_a_retry_may_heal_or_a_paused_team_is_not_amber() {
        let mut offline = executor("a", "stopped", false);
        offline.failure = Some(classify("Executor API request timed out."));
        let mut unknown = executor("b", "stopped", false);
        unknown.failure = Some(classify("getaddrinfo ENOTFOUND api.nessie.works"));
        let mut paused = executor("c", "stopped", true);
        paused.failure = Some(classify("Executor connection is fenced."));
        let mut reconnecting = executor("d", "starting", false);
        reconnecting.failure = Some(classify("Executor connection is fenced."));
        let view = reachable(vec![offline, unknown, paused, reconnecting]);
        assert_eq!(english(&view, &BTreeMap::new(), None).needs_you, None);
    }

    #[test]
    fn the_sentence_follows_the_persons_language() {
        let view = reachable(vec![executor("a", "running", false), executor("b", "running", false)]);
        let names = named(&[("a", "Prodej"), ("b", "Provoz")]);
        assert_eq!(build(&view, &names, None, table(Locale::Cs), Locale::Cs).status, "Pracuje pro 2 týmy");
        assert_eq!(build(&view, &names, None, table(Locale::De), Locale::De).status, "Arbeitet für 2 Teams");
    }
}
