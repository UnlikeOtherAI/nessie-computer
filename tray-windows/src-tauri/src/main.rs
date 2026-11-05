// A tray application must never flash a console window at login.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

//! `nessie-executor-tray.exe` — the Nessie Executor's control surface beside the
//! Windows clock.
//!
//! Right-click gives the menu; left-click opens the shared executor console.
//! New connections run in this user's session; existing service connections
//! use the authenticated control pipe. The CLI owns all keys and local policy.
//!
//! It has one other mode, which it invokes on itself: `--grant-workspace <path>`
//! is the elevated half of pairing.
//!
//! Everything except the Win32 modules also compiles and runs its tests on a
//! non-Windows host, deliberately: the menu ids, the invitation parser, the
//! icon state machine and the pipe protocol's decoding are where the behaviour
//! lives, and a check that only ever runs on the release machine is a check
//! nobody runs. On such a host the pipe and the grant are stubs, so the
//! protocol's own error texts go unused — hence the one allow below, scoped to
//! that build alone and never applied to the shipped binary.
#![cfg_attr(not(windows), allow(dead_code))]

mod commands;
mod companion_attestation;
mod console_commands;
mod custody_cleanup;
mod grant;
mod menu;
mod nessie_desktop;
mod notification;
mod pairing_code;
mod pairing_origin;
mod personal_chatgpt;
mod pipe_client;
#[cfg(windows)]
mod registry;
mod restart_setting;
mod service_identity;
mod service_peer;
mod state;
mod sync_status;
mod user_connections;
mod user_runtime;

use std::time::Duration;

use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter,
};

use menu::{parse_menu_id, ConsoleSection, ConsoleTarget, MenuAction};
use state::{tray_state, ServiceView};

const TRAY_ID: &str = "nessie-executor";

/// How often the tray asks the service what is true. Short enough that starting
/// a daemon turns the icon green while the person is still looking at it, long
/// enough to cost nothing.
const POLL_INTERVAL: Duration = Duration::from_secs(3);

/// Folder sync is read by starting the CLI, so the poll reads it this often,
/// and pointing at the icon reads it again when the last read is older than
/// the hover interval — the menu is then current when it opens.
const SYNC_INTERVAL: Duration = Duration::from_secs(30);
const SYNC_HOVER_INTERVAL: Duration = Duration::from_secs(5);

fn apply(app: &AppHandle, view: &ServiceView) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let sync = sync_status::current();
    let sync_needs_you = sync.as_ref().is_some_and(|overview| overview.line.needs_you());
    if let Ok(icon) = Image::from_bytes(state::with_sync(tray_state(view), sync_needs_you).icon_bytes()) {
        let _ = tray.set_icon(Some(icon));
    }
    let _ = tray.set_tooltip(Some(sync_status::tooltip(state::header_label(view), sync.as_ref())));
    if let Ok(menu) = menu::build(app, view, sync.as_ref()) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// The poll runs off the main thread and the tray is updated on it: menus are a
/// main-thread object on Windows.
fn start_polling(app: AppHandle) {
    std::thread::spawn(move || {
        // A prior tray/controller crash preserved the service fence. Native
        // deletion and complete process/job observations decide recovery.
        custody_cleanup::attempt();
        loop {
            user_connections::restart_stopped();
            let view = commands::view();
            sync_status::refresh_if_older(&view, SYNC_INTERVAL);
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || apply(&handle, &view));
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

/// Pointing at the icon reads folder sync again, unless it was read moments ago.
fn refresh_sync_on_hover(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let view = commands::view();
        if sync_status::refresh_if_older(&view, SYNC_HOVER_INTERVAL) {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || apply(&handle, &view));
        }
    });
}

fn refresh_now(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let view = commands::view();
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || apply(&handle, &view));
    });
}

/// Menu clicks arrive on the main thread, and every one of these actions opens
/// a modal dialog, so each is handed to the async runtime rather than blocking
/// the thread that has to draw it.
fn handle_menu(app: &AppHandle, id: &str) {
    match parse_menu_id(id) {
        MenuAction::Start(executor_id) => spawn_action(app, "Start Nessie executor", {
            let app = app.clone();
            async move { commands::start(app, executor_id).await.map(|_| ()) }
        }),
        MenuAction::Stop(executor_id) => spawn_action(app, "Stop Nessie executor", {
            let app = app.clone();
            async move { commands::stop(app, executor_id).await.map(|_| ()) }
        }),
        // The surfaces this app exists for. They always open the status window
        // and select their section, even unpaired, because a hidden capability
        // is a capability nobody can find. The Sync line also names the team
        // its status is about, so the console shows that team's Sync tab.
        MenuAction::Open(section, target) => open_section(app, section, target),
        // Pairing needs a text field, so it opens the status window on its pair
        // form rather than trying to be a dialog.
        MenuAction::Pair => {
            commands::show_status(app);
            let _ = app.emit_to("status", "tray://pair", ());
        }
        MenuAction::OpenNessie => report(
            app,
            "Open Nessie",
            commands::open_nessie(app, pairing_origin::NESSIE_PRESET_ORIGIN),
        ),
        MenuAction::OpenLogs => report(app, "Open logs folder", commands::open_logs(app)),
        // Closing this process's liveness pipes stops its user-session daemons.
        // The independent Windows service retains its own connections.
        MenuAction::Quit => app.exit(0),
        MenuAction::Unknown => {}
    }
}

fn open_section(app: &AppHandle, section: ConsoleSection, target: ConsoleTarget) {
    commands::show_status(app);
    let _ = app.emit_to("status", section.event(), target);
}

fn spawn_action(
    app: &AppHandle,
    title: &'static str,
    action: impl std::future::Future<Output = Result<(), String>> + Send + 'static,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = action.await;
        report(&app, title, outcome);
        refresh_now(&app);
    });
}

fn report(app: &AppHandle, title: &'static str, outcome: Result<(), String>) {
    if let Err(reason) = outcome {
        commands::notify(app, title, reason);
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let view = ServiceView::Unreachable {
        reason: "checking…".to_owned(),
    };
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(tray_state(&view).icon_bytes())?)
        .tooltip(state::header_label(&view))
        .menu(&menu::build(app, &view, None)?)
        // Without this, a left-click opens the menu and the status window is
        // unreachable.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => commands::show_status(tray.app_handle()),
            TrayIconEvent::Enter { .. } => refresh_sync_on_hover(tray.app_handle()),
            _ => {}
        })
        .build(app)?;
    Ok(())
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

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
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
            personal_chatgpt::executor_chatgpt_usage,
            commands::executor_choose_folder,
            commands::executor_hide_status,
            commands::executor_open_logs,
            commands::executor_open_nessie,
            commands::executor_pairing_backends,
            pairing_code::executor_pairing_start,
            pairing_code::executor_pairing_status,
            pairing_code::executor_pairing_cancel,
            commands::executor_reconnect,
            commands::executor_set_running,
            commands::executor_start,
            commands::executor_stop,
            commands::executor_view,
            notification::executor_notify,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            build_tray(&handle)?;
            user_connections::start_paired();
            start_polling(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the Nessie Executor tray could not start");
}
