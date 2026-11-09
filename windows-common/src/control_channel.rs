//! One request to the service's control pipe from a person's own account,
//! after proving the pipe is served by the signed service.
//!
//! This is the command line's way in: `nessie-computer` runs the installed
//! service executable's `--control` mode, which calls [`call`] as the person
//! who typed the command. The pipe's DACL and the service decide everything
//! else — who is admitted, and what each account may see or answer — exactly
//! as they do for the Windows app.
//!
//! Framing and the refusal words are portable and tested on any host; the pipe
//! itself lives behind `cfg(windows)`.

use std::io::{BufRead, BufReader, Read};

/// The largest answer read back; a service answering more is not answering.
pub const MAX_ANSWER_BYTES: u64 = 1_048_576;

/// Why the service could not be asked at all. The command line words each one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unreachable {
    /// The pipe does not exist: the service is stopped or not installed.
    NotRunning,
    /// The pipe refused this Windows account.
    NotAdmitted,
    /// Something other than the signed service serves the pipe; nothing was sent.
    NotTrusted,
    Busy,
    Failed,
}

impl Unreachable {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotRunning => "notRunning",
            Self::NotAdmitted => "notAdmitted",
            Self::NotTrusted => "notTrusted",
            Self::Busy => "busy",
            Self::Failed => "failed",
        }
    }

    /// The one line `--control` prints instead of an answer.
    pub fn answer(self) -> String {
        format!("{{\"status\":\"unreachable\",\"reason\":\"{}\"}}\n", self.code())
    }
}

/// One request line as the command line sends it: a single JSON object, no
/// embedded newline, within the service's own size limit. The service checks
/// the command itself; this only keeps one connection to one request.
pub fn request_line(input: &str, max_bytes: usize) -> Option<String> {
    let line = input.strip_suffix('\n').unwrap_or(input).trim_end_matches('\r');
    if line.is_empty() || line.len() > max_bytes || line.contains(['\n', '\r']) {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(line).ok()?;
    parsed.as_object()?.get("command")?.as_str()?;
    Some(format!("{line}\n"))
}

/// One complete newline-framed answer. A pipe server may close right after
/// writing, which Windows reports as a broken pipe rather than end-of-file, so
/// reading stops at the first newline; a missing newline is an incomplete answer.
pub fn read_answer(reader: impl Read) -> Result<String, Unreachable> {
    let mut answer = String::new();
    BufReader::new(reader.take(MAX_ANSWER_BYTES))
        .read_line(&mut answer)
        .map_err(|_| Unreachable::Failed)?;
    if !answer.ends_with('\n') {
        return Err(Unreachable::Failed);
    }
    Ok(answer)
}

#[cfg(windows)]
pub fn call(request: &str, pin: Option<&str>) -> Result<String, Unreachable> {
    use std::{io::Write, mem::ManuallyDrop, os::windows::ffi::OsStrExt, os::windows::io::FromRawHandle};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY},
        Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING},
        System::Pipes::WaitNamedPipeW,
    };
    let name: Vec<u16> = std::ffi::OsStr::new(crate::CONTROL_PIPE_NAME)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut handle = None;
    // The service serves each connection on its own thread: busy is a burst.
    for _ in 0..3 {
        let opened = unsafe {
            CreateFileW(
                name.as_ptr(),
                crate::CONTROL_PIPE_CLIENT_ACCESS,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if !opened.is_null() && opened != windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            handle = Some(opened);
            break;
        }
        match unsafe { GetLastError() } {
            ERROR_PIPE_BUSY => unsafe {
                WaitNamedPipeW(name.as_ptr(), 2_000);
            },
            ERROR_FILE_NOT_FOUND => return Err(Unreachable::NotRunning),
            ERROR_ACCESS_DENIED => return Err(Unreachable::NotAdmitted),
            _ => return Err(Unreachable::Failed),
        }
    }
    let handle = handle.ok_or(Unreachable::Busy)?;
    // Nothing is written until the server is shown to be the signed service
    // running as its own account: a stopped service leaves the name free for
    // any program to claim.
    if crate::service_channel::verify(handle, pin).is_err() {
        unsafe { CloseHandle(handle) };
        return Err(Unreachable::NotTrusted);
    }
    let file = ManuallyDrop::new(unsafe { std::fs::File::from_raw_handle(handle.cast()) });
    let answer = (&*file)
        .write_all(request.as_bytes())
        .and_then(|()| (&*file).flush())
        .map_err(|_| Unreachable::Failed)
        .and_then(|()| read_answer(&*file));
    unsafe { CloseHandle(handle) };
    answer
}

#[cfg(test)]
mod tests {
    use super::{read_answer, request_line, Unreachable};

    #[test]
    fn a_request_is_one_json_command_on_one_line() {
        assert_eq!(request_line("{\"command\":\"status\"}\n", 64).as_deref(), Some("{\"command\":\"status\"}\n"));
        assert_eq!(request_line("{\"command\":\"status\"}\r\n", 64).as_deref(), Some("{\"command\":\"status\"}\n"));
        for input in [
            "",
            "\n",
            "not json\n",
            "[\"status\"]\n",
            "{\"executorId\":\"a\"}\n",
            "{\"command\":\"status\"}\n{\"command\":\"remove\"}\n",
            "{\"command\":\"status\",\"pad\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"}\n",
        ] {
            assert_eq!(request_line(input, 64), None, "{input:?}");
        }
    }

    #[test]
    fn an_answer_is_complete_only_with_its_newline() {
        assert_eq!(read_answer(&b"{\"status\":\"ok\"}\nignored"[..]), Ok("{\"status\":\"ok\"}\n".to_owned()));
        assert_eq!(read_answer(&b"{\"status\":\"ok\"}"[..]), Err(Unreachable::Failed));
        let oversized = format!("{}\n", "x".repeat(super::MAX_ANSWER_BYTES as usize));
        assert_eq!(read_answer(oversized.as_bytes()), Err(Unreachable::Failed));
    }

    #[test]
    fn each_unreachable_reason_is_one_line_the_command_line_reads() {
        for (reason, code) in [
            (Unreachable::NotRunning, "notRunning"),
            (Unreachable::NotAdmitted, "notAdmitted"),
            (Unreachable::NotTrusted, "notTrusted"),
            (Unreachable::Busy, "busy"),
            (Unreachable::Failed, "failed"),
        ] {
            let answer: serde_json::Value = serde_json::from_str(reason.answer().trim_end()).unwrap();
            assert_eq!(answer, serde_json::json!({ "status": "unreachable", "reason": code }));
            assert!(reason.answer().ends_with('\n'));
        }
    }
}
