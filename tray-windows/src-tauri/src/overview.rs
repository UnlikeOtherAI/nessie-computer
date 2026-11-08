//! What the menu and the icon say, decided from the view as one pure function.
//!
//! Connections are grouped into teams first: the connection this app runs and
//! the service's ChatGPT plan connection to the same team are one line, one
//! pause and one count. Then the status sentence, and at most one "Needs you"
//! line naming the most pressing thing only the owner can settle.

use std::collections::BTreeMap;

use nessie_windows_common::failure::remedy;

use crate::{
    state::{ExecutorStatus, ServiceView},
    sync_status::SyncOverview,
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

/// The one thing the owner is asked to look at, and where it opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NeedsYou {
    /// Program requests wait; they are answered on Overview.
    Requests(usize),
    /// Nessie needs the owner to confirm this team again.
    OwnerConfirmation { executor_id: String },
    /// This team's documents need a decision.
    Documents { executor_id: String, label: String },
    /// This team stopped for a reason the owner can fix.
    Failure { executor_id: String, label: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overview {
    pub status: String,
    pub needs_you: Option<(NeedsYou, String)>,
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

    let working = groups.iter().filter(|team| team.iter().any(|executor| executor.working())).count();
    let connecting = groups.iter().any(|team| team.iter().any(|executor| {
        !executor.paused && executor.daemon_status == "starting"
    }));
    let status = if groups.is_empty() {
        words.no_teams.to_owned()
    } else if working > 0 {
        words.working.pick(locale, working)
    } else if teams.iter().all(|team| team.paused) {
        words.paused.to_owned()
    } else if connecting {
        words.connecting.to_owned()
    } else {
        words.not_connected.to_owned()
    };

    let requests: usize = executors.iter().map(|executor| executor.pending_program_requests).sum();
    let owner = executors.iter().find(|executor| matches!(names.get(&executor.executor_id), Some(Entry::OwnerConfirmation)));
    let documents = sync.filter(|overview| overview.line.needs_you());
    let failed = executors.iter().find(|executor| {
        !executor.paused && executor.failure.as_ref().is_some_and(|failure| remedy(failure).is_some())
    });
    let needs = if requests > 0 {
        Some(NeedsYou::Requests(requests))
    } else if let Some(executor) = owner {
        Some(NeedsYou::OwnerConfirmation { executor_id: executor.executor_id.clone() })
    } else if let Some(overview) = documents {
        Some(NeedsYou::Documents { executor_id: overview.executor_id.clone(), label: label_of(&overview.executor_id) })
    } else {
        failed.map(|executor| NeedsYou::Failure {
            executor_id: executor.executor_id.clone(), label: label_of(&executor.executor_id),
        })
    };
    let needs_you = needs.map(|needs| {
        let text = match &needs {
            NeedsYou::Requests(count) => words.requests.pick(locale, *count),
            NeedsYou::OwnerConfirmation { .. } => words.owner_confirmation.to_owned(),
            NeedsYou::Documents { label, .. } => fill(words.documents, &[("team", label)]),
            NeedsYou::Failure { label, .. } => fill(words.failure, &[("team", label)]),
        };
        (needs, text)
    });
    Overview { status, needs_you, teams }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use nessie_windows_common::failure::classify;

    use super::{build, NeedsYou};
    use crate::{
        state::{tests::executor, Connection, ServiceView},
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

    #[test]
    fn the_status_sentence_counts_teams_not_connections() {
        let mut plans = executor("plans", "running", false);
        plans.connection = Connection::Service;
        let view = ServiceView::Reachable { executors: vec![
            executor("sales", "running", false), plans, executor("ops", "running", false),
        ] };
        let names = named(&[("sales", "Sales"), ("plans", "Sales"), ("ops", "Ops")]);
        let overview = english(&view, &names, None);
        assert_eq!(overview.status, "Working for 2 teams");
        assert_eq!(overview.teams.len(), 2);
        assert_eq!(overview.teams[0].executor_ids, ["sales", "plans"]);
        assert_eq!(overview.teams[0].label, "Sales · Acme");
        assert_eq!(overview.needs_you, None);
    }

    #[test]
    fn each_state_has_its_own_sentence() {
        let names = BTreeMap::new();
        let sentence = |executors| english(&ServiceView::Reachable { executors }, &names, None).status;
        assert_eq!(sentence(vec![]), "No teams connected");
        assert_eq!(sentence(vec![executor("a", "running", true), executor("b", "stopped", true)]), "Paused");
        assert_eq!(sentence(vec![executor("a", "starting", false)]), "Connecting…");
        assert_eq!(sentence(vec![executor("a", "stopped", false)]), "Not connected — open Nessie Computer");
        assert_eq!(sentence(vec![executor("a", "running", false), executor("b", "running", true)]),
            "Working for 1 team");
        let down = ServiceView::Unreachable { reason: "the service could not be reached".to_owned() };
        assert_eq!(english(&down, &names, None).status, "Can’t reach the Nessie Computer service");
    }

    #[test]
    fn needs_you_names_the_most_pressing_thing_and_where_it_opens() {
        let names = named(&[("a", "Sales"), ("b", "Ops")]);
        let mut fenced = executor("b", "stopped", false);
        fenced.failure = Some(classify("Executor connection is fenced."));
        let mut asking = executor("a", "running", false);
        asking.pending_program_requests = 2;
        let documents = SyncOverview { executor_id: "a".to_owned(), line: SyncLine::Conflicts(1) };

        let all = ServiceView::Reachable { executors: vec![asking.clone(), fenced.clone()] };
        assert_eq!(english(&all, &names, Some(&documents)).needs_you,
            Some((NeedsYou::Requests(2), "Needs you: 2 program requests".to_owned())));
        let no_requests = ServiceView::Reachable { executors: vec![executor("a", "running", false), fenced.clone()] };
        assert_eq!(english(&no_requests, &names, Some(&documents)).needs_you.unwrap().1,
            "Needs you: documents in Sales · Acme");
        assert_eq!(english(&no_requests, &names, None).needs_you,
            Some((NeedsYou::Failure { executor_id: "b".to_owned(), label: "Ops · Acme".to_owned() },
                "Needs you: Ops · Acme isn’t connected".to_owned())));
        let mut owner = names.clone();
        owner.insert("b".to_owned(), Entry::OwnerConfirmation);
        assert_eq!(english(&no_requests, &owner, None).needs_you.unwrap().1,
            "Needs you: confirm ownership in Nessie");
    }

    #[test]
    fn a_failure_without_a_fix_or_on_a_paused_team_is_not_amber() {
        let mut offline = executor("a", "stopped", false);
        offline.failure = Some(classify("Executor API request timed out."));
        let mut paused = executor("b", "stopped", true);
        paused.failure = Some(classify("Executor connection is fenced."));
        let view = ServiceView::Reachable { executors: vec![offline, paused] };
        assert_eq!(english(&view, &BTreeMap::new(), None).needs_you, None);
    }

    #[test]
    fn the_sentence_follows_the_persons_language() {
        let view = ServiceView::Reachable { executors: vec![executor("a", "running", false), executor("b", "running", false)] };
        let names = named(&[("a", "Prodej"), ("b", "Provoz")]);
        assert_eq!(build(&view, &names, None, table(Locale::Cs), Locale::Cs).status, "Pracuje pro 2 týmy");
        assert_eq!(build(&view, &names, None, table(Locale::De), Locale::De).status, "Arbeitet für 2 Teams");
    }
}
