//! The right-click menu, rebuilt from the service's answer on every poll.
//!
//! The first line is disabled and says what the icon means. Then one submenu per
//! paired executor carrying **Start** and **Stop**, then the surfaces this app
//! exists for — Settings, Where it can reach, Tools it can run, and Sync with
//! its live status — followed by Pair, Open Nessie, Open logs and Quit.
//! **Quit** says what it does and does not do, because a tray whose Quit
//! silently stopped a boot-time service would be the single most surprising
//! thing this application could do.

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Runtime,
};

use crate::{
    state::{header_label, short_id, ServiceView},
    sync_status::{menu_label, SyncOverview},
};

pub const SETTINGS_ID: &str = "settings";
pub const REACH_ID: &str = "reach";
pub const TOOLS_ID: &str = "tools";
pub const SYNC_ID: &str = "sync";
pub const PAIR_ID: &str = "pair";
pub const OPEN_NESSIE_ID: &str = "open-nessie";
pub const OPEN_LOGS_ID: &str = "open-logs";
pub const QUIT_ID: &str = "quit";

const START_PREFIX: &str = "start:";
const STOP_PREFIX: &str = "stop:";
const SYNC_PREFIX: &str = "sync:";

/// A console tab the tray opens. The console listens for one event per tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsoleSection {
    Settings,
    Reach,
    Tools,
    Sync,
}

impl ConsoleSection {
    pub fn event(self) -> &'static str {
        match self {
            Self::Settings => "tray://section/settings",
            Self::Reach => "tray://section/reach",
            Self::Tools => "tray://section/tools",
            Self::Sync => "tray://section/sync",
        }
    }
}

/// A section event's payload: the team to show first, when the menu line is
/// about one team. The console ignores a team it does not list.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor_id: Option<String>,
}

/// What a clicked menu id means. Ids carry their executor so the tray keeps no
/// selection state that could drift from what the menu is showing.
#[derive(Debug, PartialEq, Eq)]
pub enum MenuAction {
    Open(ConsoleSection, ConsoleTarget),
    OpenLogs,
    OpenNessie,
    Pair,
    Quit,
    Start(String),
    Stop(String),
    Unknown,
}

fn open(section: ConsoleSection, executor_id: Option<&str>) -> MenuAction {
    MenuAction::Open(section, ConsoleTarget { executor_id: executor_id.map(str::to_owned) })
}

pub fn parse_menu_id(id: &str) -> MenuAction {
    if let Some(executor_id) = id.strip_prefix(START_PREFIX) {
        return MenuAction::Start(executor_id.to_owned());
    }
    if let Some(executor_id) = id.strip_prefix(STOP_PREFIX) {
        return MenuAction::Stop(executor_id.to_owned());
    }
    if let Some(executor_id) = id.strip_prefix(SYNC_PREFIX) {
        return open(ConsoleSection::Sync, Some(executor_id));
    }
    match id {
        PAIR_ID => MenuAction::Pair,
        SETTINGS_ID => open(ConsoleSection::Settings, None),
        REACH_ID => open(ConsoleSection::Reach, None),
        TOOLS_ID => open(ConsoleSection::Tools, None),
        SYNC_ID => open(ConsoleSection::Sync, None),
        OPEN_NESSIE_ID => MenuAction::OpenNessie,
        OPEN_LOGS_ID => MenuAction::OpenLogs,
        QUIT_ID => MenuAction::Quit,
        _ => MenuAction::Unknown,
    }
}

/// The Sync line's id names the team its status is about, so the click opens
/// that team's Sync tab.
pub fn sync_menu_id(sync: Option<&SyncOverview>) -> String {
    sync.map_or_else(|| SYNC_ID.to_owned(), |overview| format!("{SYNC_PREFIX}{}", overview.executor_id))
}

pub fn build<R: Runtime>(
    app: &AppHandle<R>,
    view: &ServiceView,
    sync: Option<&SyncOverview>,
) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "header", header_label(view), false, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    if let ServiceView::Reachable { executors } = view {
        for executor in executors {
            let label = format!("{} — {}", short_id(&executor.executor_id), executor.daemon_status);
            let entry = Submenu::with_items(
                app,
                label,
                true,
                &[
                    &MenuItem::with_id(
                        app,
                        format!("{START_PREFIX}{}", executor.executor_id),
                        "Start",
                        executor.daemon_status == "stopped",
                        None::<&str>,
                    )?,
                    &MenuItem::with_id(
                        app,
                        format!("{STOP_PREFIX}{}", executor.executor_id),
                        "Stop",
                        matches!(executor.daemon_status.as_str(), "running" | "starting"),
                        None::<&str>,
                    )?,
                ],
            )?;
            menu.append(&entry)?;
        }
        if !executors.is_empty() {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }
    }
    menu.append(&MenuItem::with_id(app, SETTINGS_ID, "Settings…", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, REACH_ID, "Where it can reach…", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, TOOLS_ID, "Tools it can run…", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, sync_menu_id(sync), menu_label(sync), true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, PAIR_ID, "Add team", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, OPEN_NESSIE_ID, "Open Nessie", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, OPEN_LOGS_ID, "Open logs folder", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        QUIT_ID,
        "Quit (stops this app’s connections)",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

#[cfg(test)]
mod tests {
    use super::{
        parse_menu_id, sync_menu_id, ConsoleSection, ConsoleTarget, MenuAction, OPEN_LOGS_ID,
        OPEN_NESSIE_ID, PAIR_ID, QUIT_ID, REACH_ID, SETTINGS_ID, SYNC_ID, TOOLS_ID,
    };
    use crate::sync_status::{SyncLine, SyncOverview};

    const TEAM: &str = "1f2e3d4c-0000-4000-8000-000000000001";

    fn section(section: ConsoleSection, executor_id: Option<&str>) -> MenuAction {
        MenuAction::Open(section, ConsoleTarget { executor_id: executor_id.map(str::to_owned) })
    }

    #[test]
    fn a_clicked_line_carries_the_executor_it_belongs_to() {
        assert_eq!(parse_menu_id(&format!("start:{TEAM}")), MenuAction::Start(TEAM.to_owned()));
        assert_eq!(parse_menu_id(&format!("stop:{TEAM}")), MenuAction::Stop(TEAM.to_owned()));
        assert_eq!(parse_menu_id(&format!("sync:{TEAM}")), section(ConsoleSection::Sync, Some(TEAM)));
    }

    #[test]
    fn the_standing_entries_are_the_only_other_ones() {
        assert_eq!(parse_menu_id(PAIR_ID), MenuAction::Pair);
        assert_eq!(parse_menu_id(SETTINGS_ID), section(ConsoleSection::Settings, None));
        assert_eq!(parse_menu_id(REACH_ID), section(ConsoleSection::Reach, None));
        assert_eq!(parse_menu_id(TOOLS_ID), section(ConsoleSection::Tools, None));
        assert_eq!(parse_menu_id(SYNC_ID), section(ConsoleSection::Sync, None));
        assert_eq!(parse_menu_id(OPEN_NESSIE_ID), MenuAction::OpenNessie);
        assert_eq!(parse_menu_id(OPEN_LOGS_ID), MenuAction::OpenLogs);
        assert_eq!(parse_menu_id(QUIT_ID), MenuAction::Quit);
        // The disabled header can never be clicked, and anything else is a
        // menu this build did not create.
        for id in ["header", "", "uninstall", "start", "stop", "syncing"] {
            assert_eq!(parse_menu_id(id), MenuAction::Unknown, "id {id:?} must be unknown");
        }
    }

    /// The Sync line lands on the Sync tab of the team its status is about.
    #[test]
    fn the_sync_line_opens_the_team_it_describes() {
        let overview = SyncOverview { executor_id: TEAM.to_owned(), line: SyncLine::Conflicts(3) };
        assert_eq!(parse_menu_id(&sync_menu_id(Some(&overview))), section(ConsoleSection::Sync, Some(TEAM)));
        assert_eq!(parse_menu_id(&sync_menu_id(None)), section(ConsoleSection::Sync, None));
    }

    /// The events the shared console listens for, and the payload it reads.
    #[test]
    fn each_section_has_the_event_the_console_listens_for() {
        assert_eq!(ConsoleSection::Settings.event(), "tray://section/settings");
        assert_eq!(ConsoleSection::Reach.event(), "tray://section/reach");
        assert_eq!(ConsoleSection::Tools.event(), "tray://section/tools");
        assert_eq!(ConsoleSection::Sync.event(), "tray://section/sync");
        let target = ConsoleTarget { executor_id: Some(TEAM.to_owned()) };
        assert_eq!(serde_json::to_value(target).unwrap(), serde_json::json!({ "executorId": TEAM }));
        assert_eq!(serde_json::to_value(ConsoleTarget::default()).unwrap(), serde_json::json!({}));
    }
}
