//! Bounded control calls to the authenticated SYSTEM updater, shared by CLI and tray.
use std::{
    fs::File,
    io::{Read, Write},
    os::windows::{ffi::OsStrExt, io::FromRawHandle},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, ERROR_NO_DATA, INVALID_HANDLE_VALUE},
    Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING},
    System::Pipes::{SetNamedPipeHandleState, WaitNamedPipeW, PIPE_NOWAIT},
};

pub const PIPE: &str = r"\\.\pipe\NessieExecutorUpdater";
const REJECTED: &str = "update.coordinator_unavailable";

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    reason: String,
    stage: &'static str,
    os_error: Option<i32>,
    broker_error: Option<String>,
}
impl Failure {
    fn at(stage: &'static str) -> Self {
        Self {
            reason: REJECTED.into(),
            stage,
            os_error: None,
            broker_error: None,
        }
    }
    fn os(stage: &'static str, error: i32) -> Self {
        Self {
            os_error: Some(error),
            ..Self::at(stage)
        }
    }
}

pub fn call(request: &serde_json::Value, eku: Option<&str>) -> Result<serde_json::Value, String> {
    exchange(request, eku).map_err(|failure| failure.reason)
}

/// Fixed read-only diagnostic using the production transport and authentication.
/// Failure details never change the app's public error or its trust decision.
pub fn inspect_status(eku: Option<&str>) -> Result<serde_json::Value, Failure> {
    exchange(&serde_json::json!({"operation":"status"}), eku)
}

fn exchange(request: &serde_json::Value, eku: Option<&str>) -> Result<serde_json::Value, Failure> {
    let mut bytes = serde_json::to_vec(request).map_err(|_| Failure::at("request_json"))?;
    if bytes.len() > 4096 {
        return Err(Failure::at("request_size"));
    }
    bytes.push(b'\n');
    let name: Vec<u16> = std::ffi::OsStr::new(PIPE)
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe { WaitNamedPipeW(name.as_ptr(), 5000) };
    let handle = unsafe {
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
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(Failure::os("pipe_open", unsafe { GetLastError() } as i32));
    }
    if let Err(error) = crate::service_channel::verify_updater(handle, eku) {
        unsafe { CloseHandle(handle) };
        return Err(Failure {
            reason: error,
            ..Failure::at("peer_verification")
        });
    }
    // A stalled broker must not hold a window or daemon thread forever. Byte-mode
    // nonblocking I/O shares one deadline across the write and bounded response.
    let mode = PIPE_NOWAIT;
    if unsafe { SetNamedPipeHandleState(handle, &mode, std::ptr::null(), std::ptr::null()) } == 0 {
        let error = unsafe { GetLastError() };
        unsafe { CloseHandle(handle) };
        return Err(Failure::os("client_mode", error as i32));
    }
    let mut stream = unsafe { File::from_raw_handle(handle.cast()) };
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut sent = 0;
    let mut response = Vec::new();
    loop {
        if Instant::now() >= deadline {
            return Err(Failure::at("response_deadline"));
        }
        if sent < bytes.len() {
            match stream.write(&bytes[sent..]) {
                Ok(count) => sent += count,
                Err(error) if error.raw_os_error() == Some(ERROR_NO_DATA as i32) => {}
                Err(error) => {
                    return Err(Failure::os(
                        "write",
                        error.raw_os_error().unwrap_or_default(),
                    ))
                }
            }
        } else {
            let mut buffer = [0; 1024];
            match stream.read(&mut buffer) {
                Ok(0) => return Err(Failure::at("response_eof")),
                Ok(count) => response.extend_from_slice(&buffer[..count]),
                Err(error) if error.raw_os_error() == Some(ERROR_NO_DATA as i32) => {}
                Err(error) => {
                    return Err(Failure::os(
                        "read",
                        error.raw_os_error().unwrap_or_default(),
                    ))
                }
            }
            if response.len() > 16_384 {
                return Err(Failure::at("response_size"));
            }
            if response.ends_with(b"\n") {
                let value: serde_json::Value =
                    serde_json::from_slice(&response).map_err(|_| Failure::at("response_json"))?;
                return if let Some(error) = value.get("error") {
                    Err(Failure {
                        broker_error: error.as_str().map(str::to_owned),
                        ..Failure::at("broker_reply")
                    })
                } else {
                    Ok(value)
                };
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
