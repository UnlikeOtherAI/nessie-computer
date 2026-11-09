//! What the menu and the icon say, decided from the view as one pure function,
//! by the same rules as the macOS menu bar (`ComputerMenuModel`).
//!
//! Connections are grouped into teams first: the connection this app runs and
//! the service's ChatGPT plan connection to the same team are one line, one
//! pause and one count. Each team then has at most one thing only its owner
//! can settle; one such thing is named, several read "N things".

use crate::{
    menu::ConsoleSection,
    state::{ExecutorStatus, ServiceView},
    sync_status::{SyncLine, SyncOverview},
    team_names::{label, same_team, TeamIdentity},
    words::{fill, Locale, Words, APP_NAME},
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

/// The one "Needs you" line, and the place it opens: a console section, or
/// the window as it was (`None`: its Needs you strip shows on every tab).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeedsYou {
    pub text: String,
    pub section: Option<ConsoleSection>,
    pub executor_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overview {
    pub status: String,
    pub needs_you: Option<NeedsYou>,
    pub teams: Vec<Team>,
}

/// The longest tooltip Windows keeps: 128 UTF-16 units with the terminator.
const TOOLTIP_UNITS: usize = 127;

impl Overview {
    /// What the menu says before the first read of the teams: the product's
    /// name, claiming nothing about them.
    pub fn unread() -> Self {
        Overview { status: APP_NAME.to_owned(), needs_you: None, teams: Vec::new() }
    }

    /// The icon's tooltip: the product's name, the status sentence the menu
    /// opens with, and the one thing that needs the owner. Windows names the
    /// icon in its settings and to screen readers by the tooltip it was first
    /// registered with, so the name comes first in every one of them.
    pub fn tooltip(&self) -> String {
        let mut lines = vec![APP_NAME];
        if self.status != APP_NAME {
            lines.push(&self.status);
        }
        if let Some(needs) = &self.needs_you {
            lines.push(&needs.text);
        }
        within_units(&lines.join("\n"), TOOLTIP_UNITS)
    }
}

/// `text` cut at a character boundary so it fits in `units` UTF-16 units,
/// ending in an ellipsis when anything was cut.
fn within_units(text: &str, units: usize) -> String {
    if text.encode_utf16().count() <= units {
        return text.to_owned();
    }
    let mut kept = String::new();
    let mut used = 1; // the ellipsis
    for character in text.chars() {
        used += character.len_utf16();
        if used > units {
            break;
        }
        kept.push(character);
    }
    kept.push('…');
    kept
}

/// Connections grouped by the team their saved names say, in list order. A
/// connection whose team has never had a name is a team of its own.
pub fn group(executors: &[ExecutorStatus]) -> Vec<Vec<&ExecutorStatus>> {
    let mut groups: Vec<Vec<&ExecutorStatus>> = Vec::new();
    for executor in executors {
        let existing = executor.names.as_ref().and_then(|mine| groups.iter_mut().find(|group| {
            group[0].names.as_ref().is_some_and(|theirs| same_team(mine, theirs))
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

/// A failure the supervisors will not retry: it waits for the owner's remedy.
fn needs_owner(executor: &ExecutorStatus) -> bool {
    executor.failure.as_ref().is_some_and(|failure| !nessie_windows_common::failure::retriable(failure))
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
    sync: Option<&SyncOverview>,
    words: &Words,
    locale: Locale,
) -> Overview {
    let ServiceView::Reachable { executors } = view else {
        return Overview { status: words.service_unreachable.to_owned(), needs_you: None, teams: Vec::new() };
    };
    let identities: Vec<&TeamIdentity> = executors.iter().filter_map(|executor| executor.names.as_ref()).collect();
    let groups = group(executors);
    let teams: Vec<Team> = groups.iter().map(|connections| Team {
        executor_ids: connections.iter().map(|executor| executor.executor_id.clone()).collect(),
        label: label(connections[0].names.as_ref(), &identities, words.team_unavailable),
        paused: connections.iter().all(|executor| executor.paused),
    }).collect();
    let activities: Vec<Activity> = groups.iter().map(|team| activity(team)).collect();

    let mut items: Vec<NeedsYou> = Vec::new();
    for (team, connections) in teams.iter().zip(&groups) {
        let Some(reason) = team_reason(connections, sync) else { continue };
        let (section, executor_id) = match (reason, sync) {
            (Reason::Programs(_) | Reason::NotConnected, _) | (_, None) => (None, team.executor_ids[0].clone()),
            // Documents belong to the connection sync reported them for.
            (_, Some(overview)) => (Some(ConsoleSection::Documents), overview.executor_id.clone()),
        };
        items.push(NeedsYou {
            text: fill(words.needs_you, &[("team", &team.label), ("reason", &say(reason, words, locale))]),
            section,
            executor_id: Some(executor_id),
        });
    }
    let needs_you = if items.len() > 1 {
        Some(NeedsYou { text: words.needs_you_many.pick(locale, items.len()), section: None, executor_id: None })
    } else {
        items.pop()
    };
    Overview { status: status(&activities, words, locale), needs_you, teams }
}

#[cfg(test)]
mod tests {
    use nessie_windows_common::failure::classify;

    use super::{build, NeedsYou, Overview};
    use crate::{
        menu::ConsoleSection,
        state::{tests::executor, Connection, ExecutorStatus, ServiceView},
        sync_status::{SyncLine, SyncOverview},
        team_names::TeamIdentity,
        words::{table, Locale},
    };

    /// Rows that carry their team's saved name, as the poll's rows do.
    fn named(mut executors: Vec<ExecutorStatus>, pairs: &[(&str, &str)]) -> Vec<ExecutorStatus> {
        for executor in &mut executors {
            executor.names = pairs.iter().find(|(id, _)| *id == executor.executor_id).map(|(_, team)| TeamIdentity {
                api_base_url: "https://api.nessie.works".to_owned(),
                organization_name: "Acme".to_owned(),
                team_name: Some((*team).to_owned()),
            });
        }
        executors
    }

    fn english(view: &ServiceView, sync: Option<&SyncOverview>) -> super::Overview {
        build(view, sync, table(Locale::EnGb), Locale::EnGb)
    }

    fn reachable(executors: Vec<ExecutorStatus>) -> ServiceView {
        ServiceView::Reachable { executors }
    }

    #[test]
    fn the_tooltip_names_the_app_then_follows_the_status_from_no_team_to_working() {
        // Before the first read the icon claims nothing, and Windows records this name for it.
        assert_eq!(Overview::unread().tooltip(), "Nessie Computer");
        assert_eq!(Overview::unread().status, "Nessie Computer");
        let none = english(&reachable(Vec::new()), None);
        assert_eq!(none.tooltip(), "Nessie Computer\nNo team connected");
        let view = reachable(named(vec![executor("sales", "running", false), executor("ops", "running elsewhere", false)],
            &[("sales", "Sales"), ("ops", "Ops")]));
        assert_eq!(english(&view, None).tooltip(), "Nessie Computer\nWorking for 2 teams");
        let mut asking = executor("sales", "running", false);
        asking.pending_program_requests = 1;
        let needs = english(&reachable(named(vec![asking], &[("sales", "Sales")])), None);
        assert!(needs.tooltip().starts_with("Nessie Computer\nWorking for 1 team\n"), "{}", needs.tooltip());
        assert!(needs.tooltip().ends_with(&needs.needs_you.as_ref().unwrap().text));
    }

    #[test]
    fn a_long_tooltip_is_cut_to_what_windows_keeps() {
        let long = Overview { status: "Working for 1 team".to_owned(), teams: Vec::new(), needs_you: Some(NeedsYou {
            text: format!("Needs you: {} — a program asks to run", "Žluťoučký kůň ".repeat(10)),
            section: None, executor_id: None }) };
        let tooltip = long.tooltip();
        assert_eq!(tooltip.encode_utf16().count(), 127, "{tooltip}");
        assert!(tooltip.starts_with("Nessie Computer\nWorking for 1 team\nNeeds you: Žluťoučký"));
        assert!(tooltip.ends_with('…'));
    }

    #[test]
    fn the_status_sentence_counts_teams_not_connections() {
        let mut plans = executor("plans", "running", false);
        plans.connection = Connection::Service;
        let view = reachable(named(vec![executor("sales", "running", false), plans, executor("ops", "running", false)],
            &[("sales", "Sales"), ("plans", "Sales"), ("ops", "Ops")]));
        let overview = english(&view, None);
        assert_eq!(overview.status, "Working for 2 teams");
        assert_eq!(overview.teams.len(), 2);
        assert_eq!(overview.teams[0].executor_ids, ["sales", "plans"]);
        assert_eq!(overview.teams[0].label, "Sales · Acme");
        assert_eq!(overview.needs_you, None);
    }

    #[test]
    fn a_team_that_never_had_a_name_says_so_and_stands_alone() {
        let view = reachable(named(vec![executor("sales", "running", false), executor("new", "running", false)],
            &[("sales", "Sales")]));
        let labels: Vec<String> = english(&view, None).teams.into_iter().map(|team| team.label).collect();
        assert_eq!(labels, ["Sales · Acme", "Team name not available yet"]);
    }

    #[test]
    fn each_state_has_the_same_sentence_as_on_macos() {
        let sentence = |executors| english(&reachable(executors), None).status;
        assert_eq!(sentence(vec![]), "No team connected");
        assert_eq!(sentence(vec![executor("a", "running", true), executor("b", "stopped", true)]), "Paused");
        assert_eq!(sentence(vec![executor("a", "starting", false)]), "Connecting…");
        assert_eq!(sentence(vec![executor("a", "stopped", false)]), "Not connected — open Nessie Computer");
        assert_eq!(sentence(vec![executor("a", "running", false), executor("b", "running", true),
            executor("c", "stopped", false)]), "Working for 1 team · 1 paused · 1 not connected");
        let down = ServiceView::Unreachable { reason: "the service could not be reached".to_owned() };
        assert_eq!(english(&down, None).status, "Can’t reach the Nessie Computer service");
    }

    #[test]
    fn one_thing_names_its_team_and_opens_its_place() {
        let pairs = [("a", "Sales"), ("b", "Ops")];
        let mut asking = executor("a", "running", false);
        asking.pending_program_requests = 2;
        assert_eq!(english(&reachable(named(vec![asking, executor("b", "running", false)], &pairs)), None).needs_you,
            Some(NeedsYou { text: "Needs you: Sales · Acme — 2 programs ask to run".to_owned(),
                section: None, executor_id: Some("a".to_owned()) }));
        let documents = SyncOverview { executor_id: "b".to_owned(), line: SyncLine::Conflicts(1) };
        let quiet = reachable(named(vec![executor("a", "running", false), executor("b", "running", false)], &pairs));
        assert_eq!(english(&quiet, Some(&documents)).needs_you,
            Some(NeedsYou { text: "Needs you: Ops · Acme — 1 document conflict".to_owned(),
                section: Some(ConsoleSection::Documents), executor_id: Some("b".to_owned()) }));
        let mut fenced = executor("b", "stopped", false);
        fenced.failure = Some(classify("Executor connection is fenced."));
        assert_eq!(english(&reachable(named(vec![executor("a", "running", false), fenced], &pairs)), None)
            .needs_you.unwrap().text, "Needs you: Ops · Acme — not connected");
    }

    #[test]
    fn several_things_are_counted_and_open_the_window() {
        let pairs = [("a", "Sales"), ("b", "Ops")];
        let mut asking = executor("a", "running", false);
        asking.pending_program_requests = 1;
        let mut more = executor("b", "running", false);
        more.pending_program_requests = 1;
        let overview = english(&reachable(named(vec![asking, more], &pairs)), None);
        assert_eq!(overview.needs_you, Some(NeedsYou { text: "Needs you: 2 things — open Nessie Computer".to_owned(),
            section: None, executor_id: None }));
        // A team without a name never needs its owner for that: names depend on no person.
        let unnamed = english(&reachable(vec![executor("c", "running", false)]), None);
        assert_eq!(unnamed.needs_you, None);
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
        assert_eq!(english(&view, None).needs_you, None);
    }

    #[test]
    fn the_sentence_follows_the_persons_language() {
        let view = reachable(named(vec![executor("a", "running", false), executor("b", "running", false)],
            &[("a", "Prodej"), ("b", "Provoz")]));
        assert_eq!(build(&view, None, table(Locale::Cs), Locale::Cs).status, "Pracuje pro 2 týmy");
        assert_eq!(build(&view, None, table(Locale::De), Locale::De).status, "Arbeitet für 2 Teams");
    }
}
