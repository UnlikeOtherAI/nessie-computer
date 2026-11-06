//! Bounded control calls to the authenticated SYSTEM updater, shared by CLI and tray.
use std::{
    fs::File,
    io::{Read, Write},
    os::windows::{ffi::OsStrExt, io::FromRawHandle},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_NO_DATA, INVALID_HANDLE_VALUE},
    Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING},
    System::Pipes::{SetNamedPipeHandleState, WaitNamedPipeW, PIPE_NOWAIT},
};

pub const PIPE: &str = r"\\.\pipe\NessieExecutorUpdater";
const REJECTED: &str = "update.coordinator_unavailable";

pub fn call(request: &serde_json::Value, eku: Option<&str>) -> Result<serde_json::Value, String> {
    let mut bytes = serde_json::to_vec(request).map_err(|_| REJECTED)?;
    if bytes.len() > 4096 { return Err(REJECTED.into()); }
    bytes.push(b'\n');
    let name: Vec<u16> = std::ffi::OsStr::new(PIPE).encode_wide().chain(Some(0)).collect();
    unsafe { WaitNamedPipeW(name.as_ptr(), 5000) };
    let handle = unsafe {
        CreateFileW(name.as_ptr(), crate::CONTROL_PIPE_CLIENT_ACCESS, 0, std::ptr::null(),
            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, std::ptr::null_mut())
    };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE { return Err(REJECTED.into()); }
    if let Err(error) = crate::service_channel::verify_updater(handle, eku) {
        unsafe { CloseHandle(handle) };
        return Err(error);
    }
    // A stalled broker must not hold a window or daemon thread forever. Byte-mode
    // nonblocking I/O shares one deadline across the write and bounded response.
    let mode = PIPE_NOWAIT;
    if unsafe { SetNamedPipeHandleState(handle, &mode, std::ptr::null(), std::ptr::null()) } == 0 {
        unsafe { CloseHandle(handle) };
        return Err(REJECTED.into());
    }
    let mut stream = unsafe { File::from_raw_handle(handle.cast()) };
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut sent = 0;
    let mut response = Vec::new();
    loop {
        if Instant::now() >= deadline { return Err(REJECTED.into()); }
        if sent < bytes.len() {
            match stream.write(&bytes[sent..]) {
                Ok(count) => sent += count,
                Err(error) if error.raw_os_error() == Some(ERROR_NO_DATA as i32) => {},
                Err(_) => return Err(REJECTED.into()),
            }
        } else {
            let mut buffer = [0; 1024];
            match stream.read(&mut buffer) {
                Ok(0) => return Err(REJECTED.into()),
                Ok(count) => response.extend_from_slice(&buffer[..count]),
                Err(error) if error.raw_os_error() == Some(ERROR_NO_DATA as i32) => {},
                Err(_) => return Err(REJECTED.into()),
            }
            if response.len() > 16_384 { return Err(REJECTED.into()); }
            if response.ends_with(b"\n") {
                let value: serde_json::Value = serde_json::from_slice(&response).map_err(|_| REJECTED)?;
                return if value.get("error").is_some() { Err(REJECTED.into()) } else { Ok(value) };
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
