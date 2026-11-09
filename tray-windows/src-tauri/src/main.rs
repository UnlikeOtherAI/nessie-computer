// A tray application must never flash a console window at login.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

//! `nessie-executor-tray.exe` — Nessie Computer beside the Windows clock.
//!
//! Left-click opens the window; right-click gives the menu. One copy runs per
//! person: a second launch, or a `nessie-computer://` link, shows the window
//! of the copy already running. Teams connected here run in this person's
//! session; the service's own teams use its authenticated control pipe. The
//! CLI owns all keys and local policy.
//!
//! It has two other modes, which other programs invoke on it:
//! `--grant-workspace <path>` is the elevated half of a service pairing, and
//! `--personal-attestation <id>` is the CLI's bridge to the signed service.
//!
//! Everything except the Win32 modules also compiles and runs its tests on a
//! non-Windows host, deliberately: the menu model, the labels, the link parser,
//! the icon state machine and the pipe protocol's decoding are where the
//! behaviour lives. On such a host the pipe and the grant are stubs, so some
//! items go unused — hence the one allow below, scoped to that build alone.
#![cfg_attr(not(windows), allow(dead_code))]

mod commands;
mod companion_attestation;
mod console_commands;
mod custody_cleanup;
mod deep_link;
mod grant;
mod inference_connections;
mod local_ai;
mod menu;
mod menu_guard;
mod nessie_desktop;
mod notification;
mod overview;
mod owner_commands;
mod pairing_code;
mod pairing_origin;
mod personal_chatgpt;
mod pipe_client;
mod program_toast;
#[cfg(windows)]
mod registry;
mod restart_setting;
mod service_identity;
mod service_peer;
mod state;
mod sync_status;
mod team_names;
mod update_controls;
mod user_connections;
mod user_owner;
mod user_runtime;
mod words;
mod words_tables;

use std::{sync::Mutex, time::Duration};

use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter,
};

use deep_link::Link;
use menu::{parse_menu_id, ConsoleSection, ConsoleTarget, MenuAction};
use state::{tray_state, ServiceView};

const TRAY_ID: &str = "nessie-executor";

/// How often the tray asks what is true. Short enough that a program request
/// reaches the owner while the agent is still waiting, long enough to cost
/// nothing.
const POLL_INTERVAL: Duration = Duration::from_secs(3);

/// Folder sync is read by starting the CLI, so the poll reads it this often,
/// and pointing at the icon reads it again when the last read is older than
/// the hover interval — the menu is then current when it opens.
const SYNC_INTERVAL: Duration = Duration::from_secs(30);
const SYNC_HOVER_INTERVAL: Duration = Duration::from_secs(5);

/// A link this copy was started with, kept until the window asks for it.
static LAUNCH_LINK: Mutex<Option<Link>> = Mutex::new(None);

fn overview(view: &ServiceView) -> overview::Overview {
    overview::build(view, sync_status::current().as_ref(), words::words(), words::locale())
}

fn apply(app: &AppHandle, view: &ServiceView) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let overview = overview(view);
    if let Ok(icon) = Image::from_bytes(tray_state(view, overview.needs_you.is_some()).icon_bytes()) {
        let _ = tray.set_icon(Some(icon));
    }
    // The tooltip follows every poll; it is safe to change while the menu is open.
    let _ = tray.set_tooltip(Some(overview.tooltip()));
    if menu_guard::should_rebuild(&overview) {
        if let Ok(menu) = menu::build(app, &overview, words::words()) {
            if tray.set_menu(Some(menu)).is_ok() {
                menu_guard::rebuilt(overview);
            }
        }
    }
}

fn label_of(executor_id: &str) -> String {
    let names = team_names::snapshot();
    let all: Vec<&team_names::TeamIdentity> = names.values().collect();
    team_names::label(names.get(executor_id), &all, words::words().team_unavailable)
}

/// The poll runs off the main thread and the tray is updated on it: menus are a
/// main-thread object on Windows. Every row carries its team's saved name, so
/// the poll asks nobody for one (`team_names`).
fn start_polling(app: AppHandle) {
    std::thread::spawn(move || {
        // A prior tray/controller crash preserved the service fence. Native
        // deletion and complete process/job observations decide recovery.
        custody_cleanup::attempt();
        loop {
            // An installer about to replace the files asks this app to quit;
            // its teams' daemons stop on their own as their pipes close.
            #[cfg(windows)]
            if nessie_windows_common::install_handover::install_signalled() {
                app.exit(0);
                return;
            }
            user_connections::supervise();
            let view = commands::view();
            sync_status::refresh_if_older(&view, SYNC_INTERVAL);
            program_toast::notify_new(&app, &view, label_of, words::words());
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || apply(&handle, &view));
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

/// Pointing at the icon reads what is true now, so the tooltip it is about to
/// show is current, and folder sync again unless it was read moments ago.
fn refresh_on_hover(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let view = commands::view();
        sync_status::refresh_if_older(&view, SYNC_HOVER_INTERVAL);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || apply(&handle, &view));
    });
}

fn open_section(app: &AppHandle, section: Option<ConsoleSection>, target: ConsoleTarget) {
    commands::show_status(app);
    let _ = app.emit_to("status", &ConsoleSection::event_for(section), target);
}

/// A link only navigates: it opens the window on a section, or on Add another team.
fn follow(app: &AppHandle, link: Link) {
    match link {
        Link::Open(section, target) => open_section(app, section, target),
        Link::Connect => {
            commands::show_status(app);
            let _ = app.emit_to("status", "tray://connect", ());
        }
    }
}

/// Menu clicks arrive on the main thread; anything that waits for the CLI is
/// handed to a worker so the thread that draws the menu stays free.
fn handle_menu(app: &AppHandle, id: &str) {
    match parse_menu_id(id) {
        MenuAction::Open(section, target) => open_section(app, section, target),
        MenuAction::AddTeam => follow(app, Link::Connect),
        MenuAction::SetPaused { executor_id, paused } => {
            let app = app.clone();
            std::thread::spawn(move || {
                let words = words::words();
                match owner_commands::set_paused(executor_id.as_deref(), paused) {
                    Ok(view) => {
                        let handle = app.clone();
                        let _ = app.run_on_main_thread(move || apply(&handle, &view));
                    }
                    Err(reason) => {
                        commands::notify(&app, if paused { words.pause_failed } else { words.resume_failed }, reason)
                    }
                }
            });
        }
        MenuAction::OpenNessie => {
            let app = app.clone();
            std::thread::spawn(move || {
                let opened = match pairing_code::showing_code() {
                    Some(showing) => commands::open_nessie(&app, &showing.api_origin, Some(&showing.code)),
                    None => commands::open_nessie(&app, &commands::default_server(), None),
                };
                if let Err(reason) = opened {
                    commands::notify(&app, words::words().open_nessie_failed, reason);
                }
            });
        }
        // Closing this process's liveness pipes stops its user-session daemons.
        // The independent Windows service retains its own connections.
        MenuAction::Quit => app.exit(0),
        MenuAction::Unknown => {}
    }
}

/// The icon appears before the first read of the teams, so it starts idle and
/// says only the product's name; the first poll replaces both. Windows keeps
/// this first tooltip as the icon's name in its settings.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let unread = overview::Overview::unread();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(state::TrayState::Idle.icon_bytes())?)
        .tooltip(unread.tooltip())
        .menu(&menu::build(app, &unread, words::words())?)
        // Without this, a left-click opens the menu and the window is unreachable.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => commands::show_status(tray.app_handle()),
            TrayIconEvent::Enter { .. } => refresh_on_hover(tray.app_handle()),
            _ => {}
        })
        .build(app)?;
    #[cfg(windows)]
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        // Without the watch the menu still changes only when its contents do.
        let _ = tray.with_inner_tray_icon(|inner| menu_guard::watch(inner.window_handle()));
    }
    Ok(())
}

/// The link this copy was started with, once: the window asks when it has
/// loaded, so a link that started the app is never lost to a page that was
/// not listening yet.
#[tauri::command]
fn executor_launch_link() -> Option<serde_json::Value> {
    let link = LAUNCH_LINK.lock().ok()?.take()?;
    Some(match link {
        Link::Open(section, target) => serde_json::json!({ "section": section.map(ConsoleSection::name), "executorId": target.executor_id }),
        Link::Connect => serde_json::json!({ "connect": true }),
    })
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if let [switch, executor_id] = arguments.as_slice() {
        if switch == companion_attestation::SWITCH {
            if companion_attestation::run(executor_id).is_err() {
                std::process::exit(1);
            }
            return;
        }
    }
    if let [switch, path] = arguments.as_slice() {
        if switch == grant::GRANT_SWITCH {
            // The elevated half of pairing: grant one directory, record this
            // account, exit. It shows no window and never becomes the tray.
            if let Err(reason) = grant::grant_workspace(std::path::Path::new(path)) {
                eprintln!("{reason}");
                std::process::exit(1);
            }
            return;
        }
    }
    let dsn = std::env::var("NESSIE_COMPUTER_SENTRY_DSN").ok()
        .or_else(|| option_env!("NESSIE_COMPUTER_SENTRY_DSN").map(str::to_owned))
        .filter(|dsn| !dsn.is_empty());
    let _sentry = dsn.map(|dsn| sentry::init(
        sentry::ClientOptions::new().dsn(&dsn).maybe_release(option_env!("GITHUB_SHA")),
    ));
    if let (Some(link), Ok(mut pending)) = (deep_link::from_arguments(&arguments), LAUNCH_LINK.lock()) {
        *pending = Some(link);
    }

    tauri::Builder::default()
        // First, so a second copy hands over before it builds anything.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _| {
            match deep_link::from_arguments(argv.get(1..).unwrap_or_default()) {
                Some(link) => follow(app, link),
                None => commands::show_status(app),
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            update_controls::executor_update_control,
            console_commands::executor_console_describe,
            console_commands::executor_configure,
            console_commands::executor_autostart,
            console_commands::executor_set_autostart,
            console_commands::executor_auto_restart,
            console_commands::executor_set_auto_restart,
            console_commands::executor_copy_code,
            console_commands::executor_remove,
            console_commands::executor_sync_pick_folder,
            console_commands::executor_sync_status,
            console_commands::executor_sync_configure,
            console_commands::executor_sync_resolve,
            console_commands::executor_sync_trash_list,
            console_commands::executor_sync_trash_restore,
            console_commands::executor_open_path,
            console_commands::executor_sync_open_nessie,
            personal_chatgpt::executor_personal_chatgpt,
            inference_connections::executor_inference_connections,
            local_ai::executor_local_ai,
            local_ai::executor_set_local_ai,
            local_ai::executor_local_ai_add_account,
            local_ai::executor_local_ai_sign_in,
            local_ai::executor_local_ai_remove_account,
            personal_chatgpt::executor_chatgpt_usage,
            commands::executor_choose_folder,
            commands::executor_open_logs,
            commands::executor_open_nessie,
            commands::executor_pairing_backends,
            commands::executor_view,
            owner_commands::executor_set_paused,
            owner_commands::executor_apply_remedy,
            owner_commands::executor_program_requests,
            owner_commands::executor_answer_program_request,
            owner_commands::executor_sessions,
            owner_commands::executor_stop_session,
            pairing_code::executor_pairing_start,
            pairing_code::executor_pairing_status,
            pairing_code::executor_pairing_cancel,
            pairing_code::executor_chatgpt_connection_start,
            pairing_code::executor_chatgpt_connection_status,
            pairing_code::executor_chatgpt_connection_cancel,
            executor_launch_link,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // A development build never claims the scheme from the installed app.
            if !cfg!(debug_assertions) {
                deep_link::register_if_missing();
            }
            build_tray(&handle)?;
            user_connections::start_paired();
            update_controls::start(handle.clone());
            if LAUNCH_LINK.lock().is_ok_and(|pending| pending.is_some()) {
                commands::show_status(&handle);
            }
            team_names::refresh_hourly();
            start_polling(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Nessie Computer could not start");
}
