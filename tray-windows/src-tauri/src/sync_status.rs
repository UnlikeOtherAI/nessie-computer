//! The tray's one line about folder sync, read from the same
//! `nessie-executor sync status --json` the console's Sync tab draws.
//!
//! Sync is per team and runs only for connections this account owns, so the
//! tray asks each of those and shows the team that most needs the person; the
//! line opens the console on that team's Sync tab. Each read starts the CLI, so
//! it happens on a slow cadence and when the pointer reaches the icon, never on
//! every three-second poll. Nothing is cached beyond the last answer.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use serde::Deserialize;

use crate::state::ServiceView;

/// The fields of `FolderSyncConsoleState` the line needs. They are also
/// exactly `describe --json`'s `folderSync`, which is what the macOS menu bar
/// reads, so both apps derive their line from the same facts.
#[derive(Debug, Clone, Deserialize)]
pub struct SyncSummary {
    pub enabled: bool,
    pub state: String,
    pub counts: SyncCounts,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCounts {
    pub pending_uploads: u64,
    pub pending_downloads: u64,
    pub open_conflicts: u64,
    pub waiting: u64,
    pub errors: u64,
    pub held_deletes: u64,
}

/// What the line says about one team.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncLine {
    Off,
    NotPrivate,
    Paused,
    UpToDate,
    Starting,
    Offline,
    Syncing(u64),
    Conflicts(u64),
    NeedsAttention,
    AllowInNessie,
    AllowAgainInNessie,
    FolderMissing,
    DiskFull,
}

/// The console's honest rule (`syncStatusKey` in `sync.js`): never Up to date
/// while anything is pending, waiting or in conflict. Open conflicts are named
/// by count, because that is what the person is coming to resolve. A state
/// this build does not know gives no line rather than a guess.
pub fn line(summary: &SyncSummary) -> Option<SyncLine> {
    let counts = &summary.counts;
    let state = summary.state.as_str();
    if state == "not_private" {
        return Some(SyncLine::NotPrivate);
    }
    if !summary.enabled {
        return Some(SyncLine::Off);
    }
    let fixed = match state {
        "off" => Some(SyncLine::Off),
        "paused" => Some(SyncLine::Paused),
        "starting" => Some(SyncLine::Starting),
        "offline" => Some(SyncLine::Offline),
        "waiting_for_confirmation" => Some(SyncLine::AllowInNessie),
        "needs_reauthorization" => Some(SyncLine::AllowAgainInNessie),
        "root_missing" => Some(SyncLine::FolderMissing),
        "disk_full" => Some(SyncLine::DiskFull),
        "up_to_date" | "syncing" | "needs_attention" => None,
        _ => return None,
    };
    if fixed.is_some() {
        return fixed;
    }
    if counts.open_conflicts > 0 {
        return Some(SyncLine::Conflicts(counts.open_conflicts));
    }
    let pending = counts.pending_uploads + counts.pending_downloads;
    let asks = counts.held_deletes + counts.errors > 0 || state == "needs_attention";
    Some(if asks && pending == 0 {
        SyncLine::NeedsAttention
    } else if state == "up_to_date" && !asks && pending + counts.waiting == 0 {
        SyncLine::UpToDate
    } else {
        SyncLine::Syncing(pending)
    })
}

impl SyncLine {
    /// Something only the person can settle: the tray turns amber for it.
    pub fn needs_you(self) -> bool {
        matches!(
            self,
            Self::Conflicts(_)
                | Self::NeedsAttention
                | Self::AllowInNessie
                | Self::AllowAgainInNessie
                | Self::FolderMissing
                | Self::DiskFull
        )
    }

    fn rank(self) -> u8 {
        match self {
            _ if self.needs_you() => 5,
            Self::Syncing(_) | Self::Starting | Self::Offline => 4,
            Self::UpToDate => 3,
            Self::Paused => 2,
            Self::NotPrivate => 1,
            _ => 0,
        }
    }

    pub fn label(self) -> String {
        let plural = |count: u64, one: &str, other: &str| {
            format!("{count} {}", if count == 1 { one } else { other })
        };
        let text = match self {
            Self::Off => "off".to_owned(),
            Self::NotPrivate => "not on a shared computer".to_owned(),
            Self::Paused => "paused".to_owned(),
            Self::UpToDate => "up to date".to_owned(),
            Self::Starting => "starting".to_owned(),
            Self::Offline => "offline".to_owned(),
            Self::Syncing(0) => "syncing".to_owned(),
            Self::Syncing(count) => format!("syncing {}", plural(count, "file", "files")),
            Self::Conflicts(count) => plural(count, "conflict", "conflicts"),
            Self::NeedsAttention => "needs your attention".to_owned(),
            Self::AllowInNessie => "allow it in Nessie".to_owned(),
            Self::AllowAgainInNessie => "allow it again in Nessie".to_owned(),
            Self::FolderMissing => "folder missing".to_owned(),
            Self::DiskFull => "disk full".to_owned(),
        };
        format!("Sync: {text}")
    }
}

/// The team the line is about, and what it says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncOverview {
    pub executor_id: String,
    pub line: SyncLine,
}

/// The team that most needs the person; the first listed wins a tie.
pub fn most_demanding(lines: impl IntoIterator<Item = (String, SyncLine)>) -> Option<SyncOverview> {
    lines.into_iter().fold(None, |best: Option<SyncOverview>, (executor_id, line)| match best {
        Some(best) if best.line.rank() >= line.rank() => Some(best),
        _ => Some(SyncOverview { executor_id, line }),
    })
}

/// The menu line: the status when one is known, otherwise a plain doorway.
pub fn menu_label(overview: Option<&SyncOverview>) -> String {
    overview.map_or_else(|| "Sync…".to_owned(), |overview| overview.line.label())
}

/// The tooltip names sync only when it needs the person.
pub fn tooltip(header: String, overview: Option<&SyncOverview>) -> String {
    match overview {
        Some(overview) if overview.line.needs_you() => format!("{header}\n{}", overview.line.label()),
        _ => header,
    }
}

struct Cache {
    overview: Option<SyncOverview>,
    read_at: Option<Instant>,
}

static CACHE: Mutex<Cache> = Mutex::new(Cache { overview: None, read_at: None });
static READING: AtomicBool = AtomicBool::new(false);

pub fn current() -> Option<SyncOverview> {
    CACHE.lock().ok().and_then(|cache| cache.overview.clone())
}

/// Reads every owned team's sync status when the last read is older than
/// `max_age`, one read at a time. Returns whether it read.
pub fn refresh_if_older(view: &ServiceView, max_age: Duration) -> bool {
    let due = CACHE
        .lock()
        .is_ok_and(|cache| cache.read_at.is_none_or(|read_at| read_at.elapsed() >= max_age));
    if !due || READING.swap(true, Ordering::AcqRel) {
        return false;
    }
    let overview = read(view);
    if let Ok(mut cache) = CACHE.lock() {
        cache.overview = overview;
        cache.read_at = Some(Instant::now());
    }
    READING.store(false, Ordering::Release);
    true
}

/// A team whose status cannot be read is left out: the Sync tab says why.
fn read(view: &ServiceView) -> Option<SyncOverview> {
    let ServiceView::Reachable { executors } = view else {
        return None;
    };
    most_demanding(
        executors
            .iter()
            .filter(|executor| crate::user_connections::owns(&executor.executor_id))
            .filter_map(|executor| {
                let state = crate::console_commands::sync_status(&executor.executor_id).ok()?;
                let summary: SyncSummary = serde_json::from_value(state).ok()?;
                Some((executor.executor_id.clone(), line(&summary)?))
            }),
    )
}

#[cfg(test)]
mod tests {
    use super::{line, menu_label, most_demanding, tooltip, SyncLine, SyncOverview, SyncSummary};
    use serde_json::json;

    fn summary(enabled: bool, state: &str, counts: serde_json::Value) -> SyncSummary {
        let mut all = json!({"entries": 128, "pendingUploads": 0, "pendingDownloads": 0, "openConflicts": 0,
            "waiting": 0, "errors": 0, "heldDeletes": 0, "notSynced": 0});
        all.as_object_mut().unwrap().extend(counts.as_object().unwrap().clone());
        // The whole console state, as the CLI prints it: fields the line does not need are ignored.
        serde_json::from_value(json!({"executorId": "7d1c5d8e-2f4b-4c3a-9a51-0b6f0d2a1c01", "enabled": enabled,
            "paused": state == "paused", "state": state, "counts": all, "conflicts": []})).unwrap()
    }

    #[test]
    fn the_line_never_says_up_to_date_while_anything_is_left() {
        assert_eq!(line(&summary(true, "up_to_date", json!({}))), Some(SyncLine::UpToDate));
        assert_eq!(line(&summary(true, "up_to_date", json!({"pendingUploads": 3}))), Some(SyncLine::Syncing(3)));
        assert_eq!(line(&summary(true, "up_to_date", json!({"waiting": 1}))), Some(SyncLine::Syncing(0)));
        assert_eq!(line(&summary(true, "up_to_date", json!({"openConflicts": 1}))), Some(SyncLine::Conflicts(1)));
        assert_eq!(line(&summary(true, "up_to_date", json!({"heldDeletes": 23}))), Some(SyncLine::NeedsAttention));
        assert_eq!(line(&summary(true, "syncing", json!({"pendingUploads": 7, "pendingDownloads": 5}))),
            Some(SyncLine::Syncing(12)));
        assert_eq!(line(&summary(true, "needs_attention", json!({"openConflicts": 4, "errors": 1}))),
            Some(SyncLine::Conflicts(4)));
        assert_eq!(line(&summary(true, "needs_attention", json!({"errors": 1}))), Some(SyncLine::NeedsAttention));
        assert_eq!(line(&summary(true, "needs_attention", json!({"errors": 1, "pendingDownloads": 2}))),
            Some(SyncLine::Syncing(2)));
    }

    #[test]
    fn the_engine_states_that_name_their_own_remedy_keep_it() {
        for (state, expected) in [("paused", SyncLine::Paused), ("starting", SyncLine::Starting),
            ("offline", SyncLine::Offline), ("waiting_for_confirmation", SyncLine::AllowInNessie),
            ("needs_reauthorization", SyncLine::AllowAgainInNessie), ("root_missing", SyncLine::FolderMissing),
            ("disk_full", SyncLine::DiskFull)] {
            assert_eq!(line(&summary(true, state, json!({"pendingDownloads": 40}))), Some(expected), "{state}");
        }
        assert_eq!(line(&summary(false, "off", json!({}))), Some(SyncLine::Off));
        assert_eq!(line(&summary(false, "not_private", json!({}))), Some(SyncLine::NotPrivate));
        assert_eq!(line(&summary(true, "a_state_from_a_newer_runtime", json!({}))), None);
    }

    #[test]
    fn the_menu_line_is_short_and_plain() {
        let at = |line| Some(SyncOverview { executor_id: "team".to_owned(), line });
        assert_eq!(menu_label(None), "Sync…");
        assert_eq!(menu_label(at(SyncLine::UpToDate).as_ref()), "Sync: up to date");
        assert_eq!(menu_label(at(SyncLine::Off).as_ref()), "Sync: off");
        assert_eq!(menu_label(at(SyncLine::Conflicts(1)).as_ref()), "Sync: 1 conflict");
        assert_eq!(menu_label(at(SyncLine::Conflicts(3)).as_ref()), "Sync: 3 conflicts");
        assert_eq!(menu_label(at(SyncLine::Syncing(1)).as_ref()), "Sync: syncing 1 file");
        assert_eq!(menu_label(at(SyncLine::Syncing(12)).as_ref()), "Sync: syncing 12 files");
        assert_eq!(menu_label(at(SyncLine::Syncing(0)).as_ref()), "Sync: syncing");
        assert_eq!(menu_label(at(SyncLine::AllowInNessie).as_ref()), "Sync: allow it in Nessie");
    }

    #[test]
    fn the_line_is_about_the_team_that_most_needs_the_person() {
        let teams = |lines: &[SyncLine]| most_demanding(lines.iter().enumerate()
            .map(|(index, line)| (format!("team-{index}"), *line)));
        assert_eq!(teams(&[]), None);
        assert_eq!(teams(&[SyncLine::UpToDate, SyncLine::Conflicts(2), SyncLine::FolderMissing]),
            Some(SyncOverview { executor_id: "team-1".to_owned(), line: SyncLine::Conflicts(2) }));
        assert_eq!(teams(&[SyncLine::Off, SyncLine::Paused, SyncLine::UpToDate]).unwrap().executor_id, "team-2");
        assert_eq!(teams(&[SyncLine::UpToDate, SyncLine::Syncing(3)]).unwrap().line, SyncLine::Syncing(3));
        assert_eq!(teams(&[SyncLine::Off, SyncLine::Off]).unwrap().executor_id, "team-0");
    }

    #[test]
    fn the_tooltip_names_sync_only_when_it_needs_the_person() {
        let header = || "Nessie Executor — 1 of 1 running".to_owned();
        let at = |line| SyncOverview { executor_id: "team".to_owned(), line };
        assert_eq!(tooltip(header(), None), header());
        assert_eq!(tooltip(header(), Some(&at(SyncLine::Syncing(4)))), header());
        assert_eq!(tooltip(header(), Some(&at(SyncLine::Conflicts(3)))),
            "Nessie Executor — 1 of 1 running\nSync: 3 conflicts");
    }
}
