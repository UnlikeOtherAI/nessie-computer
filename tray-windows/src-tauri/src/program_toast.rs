//! A Windows toast for each program request: **Allow once**, **Always allow
//! {program}**, **Don't allow**.
//!
//! A request waits on the daemon for up to two minutes, so the toast is shown
//! as soon as a poll sees it. The answer goes back through the same path the
//! window uses, to whichever supervisor runs the team; only this person, on
//! this computer, can give it. Clicking the toast itself opens Overview, where
//! the request is listed too. Each request is shown once.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Mutex,
    time::{Duration, Instant},
};

use tauri::AppHandle;

use crate::{
    owner_commands::{self, TeamRequest},
    state::{ExecutorStatus, ServiceView},
    words::{fill, Words},
};

const REREAD: Duration = Duration::from_secs(15);
const MAX_COMMAND_CHARACTERS: usize = 120;
const MAX_PROGRAM_CHARACTERS: usize = 40;

#[derive(Default)]
struct Seen {
    shown: BTreeSet<(String, String)>,
    counts: BTreeMap<String, (usize, Instant)>,
}

static SEEN: Mutex<Option<Seen>> = Mutex::new(None);

fn shortened(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let kept: String = text.chars().take(limit.saturating_sub(1)).collect();
    format!("{kept}…")
}

/// What one toast says, decided apart from Windows so it is tested anywhere.
#[derive(Debug, PartialEq, Eq)]
pub struct ToastText {
    pub title: String,
    pub command: String,
    pub team: String,
    pub buttons: [(String, &'static str); 3],
}

pub fn toast_text(request: &TeamRequest, team_label: &str, words: &Words) -> ToastText {
    let program = shortened(&request.request.program, MAX_PROGRAM_CHARACTERS);
    let title = match request.request.agent_name.as_deref().filter(|name| !name.trim().is_empty()) {
        Some(agent) => fill(words.request_title_agent, &[("agent", agent), ("program", &program)]),
        None => fill(words.request_title, &[("program", &program)]),
    };
    let command = std::iter::once(request.request.program.as_str())
        .chain(request.request.args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    ToastText {
        title,
        command: shortened(&command.replace(char::is_control, " "), MAX_COMMAND_CHARACTERS),
        team: fill(words.request_team, &[("team", team_label)]),
        buttons: [
            (words.allow_once.to_owned(), "once"),
            (fill(words.always_allow, &[("program", &program)]), "always"),
            (words.dont_allow.to_owned(), "deny"),
        ],
    }
}

/// The teams whose request list should be read now: their count changed, or
/// requests are still waiting and the last read is old enough to have missed
/// one replacing another.
fn due(executors: &[ExecutorStatus], seen: &mut Seen, now: Instant) -> Vec<String> {
    seen.counts.retain(|id, _| executors.iter().any(|executor| &executor.executor_id == id));
    let mut due = Vec::new();
    for executor in executors {
        let count = executor.pending_program_requests;
        let changed = seen.counts.get(&executor.executor_id).is_none_or(|(last, read_at)| {
            *last != count || (count > 0 && now.duration_since(*read_at) >= REREAD)
        });
        if changed {
            seen.counts.insert(executor.executor_id.clone(), (count, now));
            if count > 0 {
                due.push(executor.executor_id.clone());
            }
        }
        if count == 0 {
            seen.shown.retain(|(id, _)| id != &executor.executor_id);
        }
    }
    due
}

/// Shows a toast for every request this process has not shown yet.
pub fn notify_new(app: &AppHandle, view: &ServiceView, label_of: impl Fn(&str) -> String, words: &'static Words) {
    let ServiceView::Reachable { executors } = view else { return };
    let teams = match SEEN.lock() {
        Ok(mut guard) => due(executors, guard.get_or_insert_with(Seen::default), Instant::now()),
        Err(_) => return,
    };
    for executor_id in teams {
        let Ok(requests) = owner_commands::program_requests_for(&executor_id) else { continue };
        for request in requests {
            let key = (request.executor_id.clone(), request.request.id.clone());
            let new = SEEN.lock().is_ok_and(|mut guard| guard.get_or_insert_with(Seen::default).shown.insert(key));
            if new {
                show(app, &request, &label_of(&request.executor_id), words);
            }
        }
    }
}

#[cfg(windows)]
fn show(app: &AppHandle, request: &TeamRequest, team_label: &str, words: &'static Words) {
    use crate::menu::{ConsoleSection, ConsoleTarget};
    use tauri::Emitter;
    use tauri_winrt_notification::{Duration as Shown, Toast};
    let text = toast_text(request, team_label, words);
    let handle = app.clone();
    let (executor_id, id) = (request.executor_id.clone(), request.request.id.clone());
    let mut toast = Toast::new(&app.config().identifier)
        .title(&text.title)
        .text1(&text.command)
        .text2(&text.team)
        .duration(Shown::Long);
    for (label, action) in &text.buttons {
        toast = toast.add_button(label, action);
    }
    let toast = toast.on_activated(move |action| {
        let (handle, executor_id, id) = (handle.clone(), executor_id.clone(), id.clone());
        std::thread::spawn(move || match action.as_deref().map(nessie_windows_common::owner_controls::Answer::parse) {
            Some(Ok(answer)) => {
                if let Err(reason) = owner_commands::answer(&executor_id, &id, answer) {
                    crate::commands::notify(&handle, words.answer_failed, reason);
                }
            }
            _ => {
                crate::commands::show_status(&handle);
                let _ = handle.emit_to("status", &ConsoleSection::Overview.event(), ConsoleTarget::default());
            }
        });
        Ok(())
    });
    if let Err(error) = toast.show() {
        eprintln!("Nessie Computer could not show a program request: {error}");
    }
}

#[cfg(not(windows))]
fn show(_: &AppHandle, _: &TeamRequest, _: &str, _: &'static Words) {}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use nessie_windows_common::owner_controls::ProgramRequest;

    use super::{due, toast_text, Seen, REREAD};
    use crate::{
        owner_commands::TeamRequest,
        state::tests::executor,
        words::{table, Locale},
    };

    fn request(agent: Option<&str>, program: &str, args: &[&str]) -> TeamRequest {
        TeamRequest {
            executor_id: "a".to_owned(),
            request: ProgramRequest {
                id: "r1".to_owned(), program: program.to_owned(),
                args: args.iter().map(|arg| (*arg).to_owned()).collect(), agent_name: agent.map(str::to_owned),
                requested_at: "2026-11-08T10:00:00.000Z".to_owned(), expires_at: "2026-11-08T10:02:00.000Z".to_owned(),
            },
        }
    }

    #[test]
    fn a_toast_names_the_agent_the_program_the_team_and_three_answers() {
        let text = toast_text(&request(Some("Builder"), "python", &["build.py", "--release"]), "Sales · Acme",
            table(Locale::EnGb));
        assert_eq!(text.title, "Builder wants to run python");
        assert_eq!(text.command, "python build.py --release");
        assert_eq!(text.team, "In Sales · Acme");
        assert_eq!(text.buttons.map(|(label, action)| format!("{label}={action}")),
            ["Allow once=once", "Always allow python=always", "Don’t allow=deny"]);
        let czech = toast_text(&request(None, "npm", &[]), "Prodej · Acme", table(Locale::Cs));
        assert_eq!(czech.title, "Agent chce spustit npm");
        assert_eq!(czech.buttons[1].0, "Vždy povolit npm");
    }

    #[test]
    fn long_or_multi_line_commands_stay_one_short_line() {
        let long = request(None, &"p".repeat(60), &["a\nb", &"x".repeat(200)]);
        let text = toast_text(&long, "T", table(Locale::EnGb));
        assert!(text.command.chars().count() <= 120 && !text.command.contains('\n'));
        assert!(text.title.ends_with("…"));
    }

    #[test]
    fn a_list_is_read_when_its_count_changes_or_waits_long_enough() {
        let mut seen = Seen::default();
        let start = Instant::now();
        let mut asking = executor("a", "running", false);
        asking.pending_program_requests = 1;
        let quiet = executor("b", "running", false);
        assert_eq!(due(&[asking.clone(), quiet.clone()], &mut seen, start), ["a"]);
        assert!(due(&[asking.clone(), quiet.clone()], &mut seen, start + Duration::from_secs(3)).is_empty());
        assert_eq!(due(&[asking.clone(), quiet.clone()], &mut seen, start + REREAD), ["a"]);
        asking.pending_program_requests = 0;
        assert!(due(&[asking, quiet], &mut seen, start + REREAD * 2).is_empty());
    }
}
