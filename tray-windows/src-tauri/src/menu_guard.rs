//! When the right-click menu may be replaced: never while it is open, and only
//! when something on it changed.
//!
//! tray-icon shows the menu with `TrackPopupMenu`, a modal loop on the main
//! thread that keeps dispatching this app's events, the 3-second poll among
//! them. Setting a new menu inside that loop destroyed the one on screen:
//! Windows stopped drawing it, and a choice made with the keyboard — slower
//! than a click — landed on a destroyed item, so Quit did nothing. The tray's
//! hidden window receives `WM_ENTERMENULOOP` and `WM_EXITMENULOOP` around the
//! loop; a subclass records them, and the poll replaces the menu only between
//! them. The next poll after the menu closes catches up.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use crate::overview::Overview;

static OPEN: AtomicBool = AtomicBool::new(false);
static SHOWN: Mutex<Option<Overview>> = Mutex::new(None);

/// The menu is rebuilt only while closed, and only for an overview it does not show yet.
fn decide(open: bool, shown: Option<&Overview>, next: &Overview) -> bool {
    !open && shown != Some(next)
}

pub fn should_rebuild(next: &Overview) -> bool {
    let shown = SHOWN.lock().ok();
    decide(OPEN.load(Ordering::SeqCst), shown.as_ref().and_then(|shown| shown.as_ref()), next)
}

/// Records the overview the menu now shows.
pub fn rebuilt(overview: Overview) {
    if let Ok(mut shown) = SHOWN.lock() {
        *shown = Some(overview);
    }
}

/// Watches the tray's own window for its menu loop. Must run on the thread
/// that owns the window (the main thread). Without it the menu still changes
/// only when its contents do.
#[cfg(windows)]
pub fn watch(hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::UI::Shell::SetWindowSubclass;
    unsafe { SetWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID, 0) != 0 }
}

/// Any id unique among this window's subclasses; tray-icon and muda use their own.
#[cfg(windows)]
const SUBCLASS_ID: usize = 0x4E43_4D47;

#[cfg(windows)]
unsafe extern "system" fn subclass(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
    _id: usize,
    _data: usize,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::{
        Shell::DefSubclassProc,
        WindowsAndMessaging::{WM_ENTERMENULOOP, WM_EXITMENULOOP},
    };
    match message {
        WM_ENTERMENULOOP => OPEN.store(true, Ordering::SeqCst),
        WM_EXITMENULOOP => OPEN.store(false, Ordering::SeqCst),
        _ => {}
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::decide;
    use crate::overview::Overview;

    fn overview(status: &str) -> Overview {
        Overview { status: status.to_owned(), needs_you: None, teams: Vec::new() }
    }

    #[test]
    fn an_open_menu_is_never_replaced_and_an_unchanged_one_is_not_rebuilt() {
        let working = overview("Working for 1 team");
        assert!(decide(false, None, &working), "the first menu is built");
        assert!(!decide(false, Some(&working), &working), "nothing changed");
        let paused = overview("Paused");
        assert!(decide(false, Some(&working), &paused), "a change is shown once the menu is closed");
        assert!(!decide(true, Some(&working), &paused), "never while the menu is open");
        assert!(!decide(true, None, &paused));
    }
}
