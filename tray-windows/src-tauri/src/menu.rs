//! The right-click menu, rebuilt from the overview on every poll.
//!
//! ```text
//! {Status sentence}                 disabled
//! {Needs you: …}                    only when the owner has something to do
//! ──────────
//! Pause | Resume                    with more than one team, a submenu:
//!                                   All teams, then one line per team (✓ paused)
//! ──────────
//! Open Nessie Computer…
//! Add this computer…                the window, straight onto a new pairing code
//! Open Nessie
//! ──────────
//! Quit Nessie Computer
//! ```
//!
//! Every clickable id carries what it acts on, so the tray keeps no selection
//! that could drift from what the menu showed. Pause and Resume ask nothing:
//! the click is the decision.

use serde::Serialize;
use tauri::{
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Runtime,
};

use crate::{
    overview::{NeedsYou, Overview, Team},
    words::Words,
};

pub const OPEN_WINDOW_ID: &str = "open-window";
pub const ADD_COMPUTER_ID: &str = "add-computer";
pub const OPEN_NESSIE_ID: &str = "open-nessie";
pub const QUIT_ID: &str = "quit";
const ALL: &str = "all";

/// A console tab. The console listens for one event per tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsoleSection {
    Overview,
    Access,
    Documents,
    Ai,
    Settings,
}

impl ConsoleSection {
    pub fn name(self) -> &'static str {
        match self {
            Self::Overview => "overview",
            Self::Access => "access",
            Self::Documents => "documents",
            Self::Ai => "ai",
            Self::Settings => "settings",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        [Self::Overview, Self::Access, Self::Documents, Self::Ai, Self::Settings]
            .into_iter()
            .find(|section| section.name() == name)
    }

    pub fn event(self) -> String {
        format!("tray://section/{}", self.name())
    }
}

/// A section event's payload: the team to show, when the line is about one.
/// The console ignores a team it does not list.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor_id: Option<String>,
}

impl ConsoleTarget {
    pub fn team(executor_id: &str) -> Self {
        Self { executor_id: Some(executor_id.to_owned()) }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum MenuAction {
    Open(ConsoleSection, ConsoleTarget),
    /// `None` is every team.
    SetPaused { executor_id: Option<String>, paused: bool },
    /// The window, on Add this computer: it asks for a pairing code at once.
    AddComputer,
    OpenNessie,
    /// The team's computer page in Nessie, where its owner confirms this computer again.
    ConfirmInNessie(String),
    Quit,
    Unknown,
}

/// The Needs you line's id: the section it opens, and the team when it names one.
pub fn needs_id(needs: &NeedsYou) -> String {
    if let (true, Some(executor_id)) = (needs.confirm, &needs.executor_id) {
        return format!("confirm:{executor_id}");
    }
    match &needs.executor_id {
        Some(executor_id) => format!("needs:{}:{executor_id}", needs.section.name()),
        None => format!("needs:{}", needs.section.name()),
    }
}

pub fn pause_id(executor_id: Option<&str>, paused: bool) -> String {
    format!("{}:{}", if paused { "pause" } else { "resume" }, executor_id.unwrap_or(ALL))
}

pub fn parse_menu_id(id: &str) -> MenuAction {
    if let Some(team) = id.strip_prefix("confirm:") {
        return if team.is_empty() { MenuAction::Unknown } else { MenuAction::ConfirmInNessie(team.to_owned()) };
    }
    if let Some(rest) = id.strip_prefix("needs:") {
        let (section, team) = rest.split_once(':').map_or((rest, None), |(section, team)| (section, Some(team)));
        return match ConsoleSection::parse(section) {
            Some(section) => MenuAction::Open(section, team.map(ConsoleTarget::team).unwrap_or_default()),
            None => MenuAction::Unknown,
        };
    }
    for (prefix, paused) in [("pause:", true), ("resume:", false)] {
        if let Some(target) = id.strip_prefix(prefix) {
            if target.is_empty() {
                return MenuAction::Unknown;
            }
            let executor_id = (target != ALL).then(|| target.to_owned());
            return MenuAction::SetPaused { executor_id, paused };
        }
    }
    match id {
        OPEN_WINDOW_ID => MenuAction::Open(ConsoleSection::Overview, ConsoleTarget::default()),
        ADD_COMPUTER_ID => MenuAction::AddComputer,
        OPEN_NESSIE_ID => MenuAction::OpenNessie,
        QUIT_ID => MenuAction::Quit,
        _ => MenuAction::Unknown,
    }
}

/// The pause section as data: what each line says, whether it is ticked, and
/// the id a click sends.
#[derive(Debug, PartialEq, Eq)]
pub enum PauseLines {
    None,
    /// One team: one line, Pause or Resume.
    Single { label: String, id: String },
    /// Several: a submenu titled Pause (or Resume when all are paused).
    Several { title: String, lines: Vec<(String, bool, String)> },
}

pub fn pause_lines(teams: &[Team], words: &Words) -> PauseLines {
    let all_paused = teams.iter().all(|team| team.paused);
    let verb = |paused: bool| if paused { words.resume } else { words.pause }.to_owned();
    match teams {
        [] => PauseLines::None,
        [_] => PauseLines::Single { label: verb(all_paused), id: pause_id(None, !all_paused) },
        _ => {
            let mut lines = vec![(words.all_teams.to_owned(), all_paused, pause_id(None, !all_paused))];
            lines.extend(teams.iter().map(|team| {
                (team.label.clone(), team.paused, pause_id(Some(&team.executor_ids[0]), !team.paused))
            }));
            PauseLines::Several { title: verb(all_paused), lines }
        }
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>, overview: &Overview, words: &Words) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "status", &overview.status, false, None::<&str>)?)?;
    if let Some(needs) = &overview.needs_you {
        menu.append(&MenuItem::with_id(app, needs_id(needs), &needs.text, true, None::<&str>)?)?;
    }
    match pause_lines(&overview.teams, words) {
        PauseLines::None => {}
        PauseLines::Single { label, id } => {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
            menu.append(&MenuItem::with_id(app, id, label, true, None::<&str>)?)?;
        }
        PauseLines::Several { title, lines } => {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
            let items = lines.into_iter()
                .map(|(label, checked, id)| CheckMenuItem::with_id(app, id, label, true, checked, None::<&str>))
                .collect::<tauri::Result<Vec<_>>>()?;
            let references: Vec<&dyn IsMenuItem<R>> = items.iter().map(|item| item as &dyn IsMenuItem<R>).collect();
            menu.append(&Submenu::with_items(app, title, true, &references)?)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, OPEN_WINDOW_ID, words.open_window, true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, ADD_COMPUTER_ID, words.add_computer, true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, OPEN_NESSIE_ID, words.open_nessie, true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, QUIT_ID, words.quit, true, None::<&str>)?)?;
    Ok(menu)
}

#[cfg(test)]
mod tests {
    use super::{
        needs_id, parse_menu_id, pause_lines, ConsoleSection, ConsoleTarget, MenuAction, PauseLines,
        ADD_COMPUTER_ID, OPEN_NESSIE_ID, OPEN_WINDOW_ID, QUIT_ID,
    };
    use crate::{
        overview::{NeedsYou, Team},
        words::{table, Locale},
    };

    const TEAM: &str = "1f2e3d4c-0000-4000-8000-000000000001";

    fn team(id: &str, label: &str, paused: bool) -> Team {
        Team { executor_ids: vec![id.to_owned()], label: label.to_owned(), paused }
    }

    #[test]
    fn the_standing_entries_open_the_window_add_this_computer_nessie_or_quit() {
        assert_eq!(parse_menu_id(OPEN_WINDOW_ID), MenuAction::Open(ConsoleSection::Overview, ConsoleTarget::default()));
        assert_eq!(parse_menu_id(ADD_COMPUTER_ID), MenuAction::AddComputer);
        assert_eq!(parse_menu_id(OPEN_NESSIE_ID), MenuAction::OpenNessie);
        assert_eq!(parse_menu_id(QUIT_ID), MenuAction::Quit);
        // No Start, Stop, Settings, logs or hidden selection remain.
        for id in ["status", "", "start:x", "stop:x", "settings", "open-logs", "pair", "pause:", "needs:billing"] {
            assert_eq!(parse_menu_id(id), MenuAction::Unknown, "id {id:?} must be unknown");
        }
    }

    #[test]
    fn a_pause_line_carries_its_team_and_the_state_it_asks_for() {
        assert_eq!(parse_menu_id("pause:all"), MenuAction::SetPaused { executor_id: None, paused: true });
        assert_eq!(parse_menu_id(&format!("resume:{TEAM}")),
            MenuAction::SetPaused { executor_id: Some(TEAM.to_owned()), paused: false });
    }

    #[test]
    fn needs_you_opens_its_exact_place() {
        let needs = |section, executor_id: Option<&str>| NeedsYou {
            text: "Needs you".to_owned(), section, executor_id: executor_id.map(str::to_owned), confirm: false,
        };
        assert_eq!(parse_menu_id(&needs_id(&needs(ConsoleSection::Overview, None))),
            MenuAction::Open(ConsoleSection::Overview, ConsoleTarget::default()));
        assert_eq!(parse_menu_id(&needs_id(&needs(ConsoleSection::Documents, Some(TEAM)))),
            MenuAction::Open(ConsoleSection::Documents, ConsoleTarget::team(TEAM)));
        assert_eq!(parse_menu_id(&needs_id(&needs(ConsoleSection::Overview, Some(TEAM)))),
            MenuAction::Open(ConsoleSection::Overview, ConsoleTarget::team(TEAM)));
        let confirm = NeedsYou { confirm: true, ..needs(ConsoleSection::Overview, Some(TEAM)) };
        assert_eq!(parse_menu_id(&needs_id(&confirm)), MenuAction::ConfirmInNessie(TEAM.to_owned()));
        assert_eq!(parse_menu_id("confirm:"), MenuAction::Unknown);
    }

    #[test]
    fn one_team_is_one_line_and_several_are_a_submenu_with_ticks() {
        let words = table(Locale::EnGb);
        assert_eq!(pause_lines(&[], words), PauseLines::None);
        assert_eq!(pause_lines(&[team("a", "Sales · Acme", false)], words),
            PauseLines::Single { label: "Pause".to_owned(), id: "pause:all".to_owned() });
        assert_eq!(pause_lines(&[team("a", "Sales · Acme", true)], words),
            PauseLines::Single { label: "Resume".to_owned(), id: "resume:all".to_owned() });
        assert_eq!(pause_lines(&[team("a", "Sales · Acme", true), team("b", "Ops · Acme", false)], words),
            PauseLines::Several { title: "Pause".to_owned(), lines: vec![
                ("All teams".to_owned(), false, "pause:all".to_owned()),
                ("Sales · Acme".to_owned(), true, "resume:a".to_owned()),
                ("Ops · Acme".to_owned(), false, "pause:b".to_owned()),
            ] });
        assert_eq!(pause_lines(&[team("a", "A", true), team("b", "B", true)], words),
            PauseLines::Several { title: "Resume".to_owned(), lines: vec![
                ("All teams".to_owned(), true, "resume:all".to_owned()),
                ("A".to_owned(), true, "resume:a".to_owned()),
                ("B".to_owned(), true, "resume:b".to_owned()),
            ] });
    }

    #[test]
    fn each_section_has_the_event_the_console_listens_for() {
        for (section, event) in [(ConsoleSection::Overview, "tray://section/overview"),
            (ConsoleSection::Access, "tray://section/access"), (ConsoleSection::Documents, "tray://section/documents"),
            (ConsoleSection::Ai, "tray://section/ai"), (ConsoleSection::Settings, "tray://section/settings")] {
            assert_eq!(section.event(), event);
            assert_eq!(ConsoleSection::parse(section.name()), Some(section));
        }
        assert_eq!(serde_json::to_value(ConsoleTarget::team(TEAM)).unwrap(), serde_json::json!({ "executorId": TEAM }));
        assert_eq!(serde_json::to_value(ConsoleTarget::default()).unwrap(), serde_json::json!({}));
    }
}
