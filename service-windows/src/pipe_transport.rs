//! Bounded byte-mode pipe I/O. Never wait in FlushFileBuffers: a peer may not read.
use std::{
    fs::File,
    io::{self, Write},
    os::windows::io::{AsRawHandle, FromRawHandle},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{ERROR_NO_DATA, HANDLE},
    System::Pipes::{
        DisconnectNamedPipe, SetNamedPipeHandleState, PIPE_NOWAIT, PIPE_READMODE_BYTE,
    },
};

const TICK: Duration = Duration::from_millis(10);

pub struct Connection(File);
impl Connection {
    /// Takes ownership even if setting the mode fails.
    pub unsafe fn from_handle(handle: HANDLE) -> io::Result<Self> {
        let connection = Self(File::from_raw_handle(handle.cast()));
        let mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
        if SetNamedPipeHandleState(handle, &mode, std::ptr::null(), std::ptr::null()) == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(connection)
    }

    pub fn handle(&self) -> HANDLE {
        self.0.as_raw_handle().cast()
    }

    pub fn request(&self, limit: usize, deadline: Instant, stopped: &AtomicBool) -> Option<String> {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        while Instant::now() < deadline && !stopped.load(Ordering::Acquire) {
            match nessie_windows_common::pipe_io::read(&self.0, &mut buffer) {
                Ok(0) => return None,
                Ok(count) => {
                    let frame = &buffer[..count];
                    let end = frame.iter().position(|byte| *byte == b'\n');
                    let length = end.map_or(count, |index| index + 1);
                    if bytes.len() + length > limit {
                        return None;
                    }
                    bytes.extend_from_slice(&frame[..length]);
                    if end.is_some() {
                        return String::from_utf8(bytes).ok();
                    }
                }
                Err(error) if no_data(&error) => std::thread::sleep(TICK),
                Err(_) => return None,
            }
        }
        None
    }

    pub fn reply(&mut self, mut bytes: &[u8], deadline: Instant, stopped: &AtomicBool) {
        while !bytes.is_empty() && Instant::now() < deadline && !stopped.load(Ordering::Acquire) {
            // PIPE_NOWAIT byte-mode writes return the available count (possibly
            // zero), rather than blocking on a client that leaves output unread.
            match self.0.write(bytes) {
                Ok(0) => std::thread::sleep(TICK),
                Ok(count) => bytes = &bytes[count..],
                Err(error) if no_data(&error) => std::thread::sleep(TICK),
                Err(_) => return,
            }
        }
        if !bytes.is_empty() {
            return;
        }
        // Existing clients read one newline-delimited answer and close. Keep
        // queued output until that close or the same reply deadline; disconnect
        // before then could discard bytes the reader has not consumed yet.
        let mut buffer = [0_u8; 1024];
        while Instant::now() < deadline && !stopped.load(Ordering::Acquire) {
            match nessie_windows_common::pipe_io::read(&self.0, &mut buffer) {
                Ok(0) => return,
                Ok(_) => {}
                Err(error) if no_data(&error) => std::thread::sleep(TICK),
                Err(_) => return,
            }
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        unsafe {
            DisconnectNamedPipe(self.handle());
        }
    }
}

fn no_data(error: &io::Error) -> bool {
    error.raw_os_error() == Some(ERROR_NO_DATA as i32)
}

/// One budget per pipe: custody saturation cannot consume control workers.
pub struct Slots {
    active: Arc<AtomicUsize>,
    limit: usize,
}
pub struct Permit(Arc<AtomicUsize>);
impl Slots {
    pub fn new(limit: usize) -> Self {
        Self {
            active: Arc::new(AtomicUsize::new(0)),
            limit,
        }
    }
    pub fn acquire(&self) -> Option<Permit> {
        self.active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < self.limit).then_some(count + 1)
            })
            .ok()?;
        Some(Permit(Arc::clone(&self.active)))
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
