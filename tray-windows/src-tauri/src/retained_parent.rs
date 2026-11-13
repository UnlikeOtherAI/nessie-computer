//! Status only from the verified daemon's inherited stdout. Receipt bytes travel
//! on its existing liveness stdin; neither stream is a public execution listener.
use std::{io::{BufRead, BufReader, Read}, sync::{Arc, Condvar, Mutex}, time::{Duration, Instant}};
use serde_json::{Value, json};

const ERROR: &str = "retained_import_handoff_unavailable";

/// Never block the tray controller on a child that stopped consuming stdin.
/// Unsupported handle mode disables this doorway; there is no blocking fallback.
#[cfg(windows)]
pub fn prepare_input(input: &std::process::ChildStdin) -> bool {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Pipes::{SetNamedPipeHandleState, PIPE_NOWAIT};
    let mode = PIPE_NOWAIT;
    unsafe { SetNamedPipeHandleState(input.as_raw_handle(), &mode, std::ptr::null(), std::ptr::null()) != 0 }
}
#[cfg(not(windows))]
pub fn prepare_input(_: &std::process::ChildStdin) -> bool {false}

#[derive(Default)]
struct State { ready: bool, ended: bool, current: Option<(String, String)> }
#[derive(Default)]
pub struct Replies { state: Mutex<State>, changed: Condvar }

impl Replies {
    pub fn read(output: impl Read + Send + 'static) -> Arc<Self> {
        let replies = Arc::new(Self::default());
        let reader = replies.clone();
        std::thread::spawn(move || {
            let mut output = BufReader::new(output);
            loop {
                let mut bytes = Vec::new();
                let read = (&mut output).take(4097).read_until(b'\n', &mut bytes);
                if !matches!(read, Ok(n) if n > 0 && n <= 4096) || bytes.last() != Some(&b'\n') {break;}
                let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {break};
                if reader.accept(value).is_err() {break;}
            }
            if let Ok(mut state) = reader.state.lock() {state.ended = true;reader.changed.notify_all();}
        });
        replies
    }
    fn accept(&self, value: Value) -> Result<(), String> {
        let object = value.as_object().ok_or(ERROR)?;
        if value["version"] != 1 || value["kind"] != "retained-import" {return Err(ERROR.into());}
        let status = value["status"].as_str().ok_or(ERROR)?;
        let mut state = self.state.lock().map_err(|_|ERROR)?;
        if status == "ready" {
            if object.len() != 3 || state.ready {return Err(ERROR.into());}
            state.ready = true;
        } else {
            if object.len() != 4 || !state.ready {return Err(ERROR.into());}
            let id = value["challengeId"].as_str().ok_or(ERROR)?;
            let current = state.current.as_mut().filter(|(expected,_)|expected == id).ok_or(ERROR)?;
            if !matches!(status,"accepted"|"published"|"stopping"|"closed"|"failed"|"refused") {
                return Err(ERROR.into());
            }
            if matches!(current.1.as_str(),"closed"|"failed"|"refused") && current.1 != status {
                return Err(ERROR.into());
            }
            // A queued accepted/published reply cannot undo a local cancellation.
            if current.1 != "stopping" || !matches!(status,"accepted"|"published") {current.1 = status.into();}
        }
        self.changed.notify_all();Ok(())
    }
    pub fn reserve(&self, id: &str) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_|ERROR)?;
        if !state.ready || state.ended || state.current.as_ref().is_some_and(|(_,s)|!matches!(s.as_str(),"closed"|"refused")) {
            return Err(ERROR.into());
        }
        state.current = Some((id.into(), "submitted".into()));Ok(())
    }
    pub fn available(&self) -> bool {
        self.state.lock().is_ok_and(|state|state.ready && !state.ended
            && state.current.as_ref().is_none_or(|(_,s)|matches!(s.as_str(),"closed"|"refused")))
    }
    pub fn cancel(&self, id: &str) -> Result<bool, String> {
        let mut state = self.state.lock().map_err(|_|ERROR)?;
        if state.ended {return Err(ERROR.into());}
        let current = state.current.as_mut().filter(|(expected,_)|expected == id).ok_or(ERROR)?;
        if matches!(current.1.as_str(),"closed"|"refused"|"stopping") {return Ok(false);}
        if current.1 == "failed" {return Err(ERROR.into());}
        current.1 = "stopping".into();Ok(true)
    }
    pub fn status(&self, id: &str) -> Option<String> {
        self.state.lock().ok()?.current.as_ref().filter(|(expected,_)|expected == id).map(|(_,s)|s.clone())
    }
    pub fn received(&self, id: &str) -> Result<Value, String> {
        self.wait(id, false)
    }
    pub fn closed(&self, id: &str) -> Result<Value, String> {
        self.wait(id, true)
    }
    fn wait(&self, id: &str, closing: bool) -> Result<Value, String> {
        let deadline = Instant::now() + Duration::from_secs(if closing {30} else {10});
        let mut state = self.state.lock().map_err(|_|ERROR)?;
        loop {
            let (_, status) = state.current.as_ref().filter(|(expected,_)|expected == id).ok_or(ERROR)?;
            if status == "failed" || (!closing && status == "refused") {
                return Err("retained_import_handoff_refused_or_unproved".into());
            }
            if matches!(status.as_str(),"closed"|"refused") || (!closing && status != "submitted") {
                return Ok(json!({"status":status}));
            }
            if state.ended {return Err(ERROR.into());}
            let Some(wait) = deadline.checked_duration_since(Instant::now()) else {
                return Err("retained_import_handoff_outcome_unknown".into());
            };
            state = self.changed.wait_timeout(state, wait).map_err(|_|ERROR)?.0;
        }
    }
}

/// A complete whole-source approval must fit one bounded inherited-pipe frame.
/// No newline is accepted from an unparsed payload and no caller chooses a verb.
pub fn begin_frame(snapshot: &Value) -> Result<(String, Vec<u8>), String> {
    if snapshot["challenge"]["selection"]["kind"] != "whole_source" {
        return Err("retained_import_whole_source_required".into());
    }
    let id = snapshot["challenge"]["challengeId"].as_str().ok_or(ERROR)?.to_owned();
    if snapshot["receipt"]["challengeId"] != id {return Err(ERROR.into());}
    let mut bytes = serde_json::to_vec(&json!({"version":1,"operation":"retained-import.begin",
        "challenge":snapshot["challenge"],"receipt":snapshot["receipt"],"expiresAtMs":snapshot["expiresAtMs"]}))
        .map_err(|_|ERROR)?;
    bytes.push(b'\n');
    if bytes.len() > 4096 {return Err("retained_import_handoff_too_large".into());}
    Ok((id, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_selected_grant_is_never_forwarded_as_whole_source() {
        assert!(begin_frame(&json!({"challenge":{"selection":{"kind":"threads"}}})).is_err());
    }
    #[test]
    fn statuses_are_correlated_and_final_outcomes_cannot_be_replaced() {
        let replies = Replies::default();
        replies.accept(json!({"version":1,"kind":"retained-import","status":"ready"})).unwrap();
        replies.reserve("synthetic-challenge").unwrap();
        assert!(replies.accept(json!({"version":1,"kind":"retained-import","challengeId":"other","status":"published"})).is_err());
        replies.accept(json!({"version":1,"kind":"retained-import","challengeId":"synthetic-challenge","status":"failed"})).unwrap();
        assert!(replies.reserve("replacement").is_err());
        assert!(replies.accept(json!({"version":1,"kind":"retained-import","challengeId":"synthetic-challenge","status":"closed"})).is_err());
    }
    #[test]
    fn queued_acceptance_cannot_undo_cancellation_and_eof_is_not_clearance() {
        let replies = Replies::default();
        replies.accept(json!({"version":1,"kind":"retained-import","status":"ready"})).unwrap();
        replies.reserve("synthetic-challenge").unwrap();
        assert!(replies.cancel("synthetic-challenge").unwrap());
        replies.accept(json!({"version":1,"kind":"retained-import","challengeId":"synthetic-challenge","status":"published"})).unwrap();
        assert_eq!(replies.status("synthetic-challenge").as_deref(),Some("stopping"));
        replies.state.lock().unwrap().ended = true;
        assert!(replies.closed("synthetic-challenge").is_err());
    }
}
