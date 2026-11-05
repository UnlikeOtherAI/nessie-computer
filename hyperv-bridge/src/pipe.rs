//! The named-pipe half. Windows only.
//!
//! Node has no `AF_HYPERV`, but `net.connect({ path: '\\\\.\\pipe\\…' })` is an
//! ordinary Node socket, so the daemon keeps one transport seam and this
//! process is the only thing that knows a Hyper-V socket exists.

use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, ERROR_PIPE_BUSY, GENERIC_READ, GENERIC_WRITE, HANDLE,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FlushFileBuffers, ReadFile, WriteFile, OPEN_EXISTING,
};
use windows_sys::Win32::System::Pipes::WaitNamedPipeW;
use windows_sys::Win32::System::Threading::GetCurrentProcess;
use windows_sys::Win32::System::IO::CancelIoEx;

use crate::pump::DuplexStream;

const CONNECT_TIMEOUT_MS: u32 = 10_000;
const DUPLICATE_SAME_ACCESS: u32 = 0x0000_0002;

fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
}

/// One connected named pipe, owned.
pub struct PipeStream(HANDLE);

unsafe impl Send for PipeStream {}

impl Drop for PipeStream {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// The daemon creates the pipe and is already listening on it before the guest
/// VM exists, exactly as the Firecracker backend opens its Unix-socket
/// listeners before `InstanceStart`. A busy pipe is waited for rather than
/// failed, because several tunnels can arrive at once.
pub fn connect(name: &str) -> io::Result<PipeStream> {
    let path = wide(name);
    loop {
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null_mut(),
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            return Ok(PipeStream(handle));
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_PIPE_BUSY as i32) {
            return Err(error);
        }
        if unsafe { WaitNamedPipeW(path.as_ptr(), CONNECT_TIMEOUT_MS) } == 0 {
            return Err(io::Error::last_os_error());
        }
    }
}

impl Read for PipeStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let mut read: u32 = 0;
        let ok = unsafe {
            ReadFile(
                self.0,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut read,
                null_mut(),
            )
        };
        if ok == 0 {
            // A closed pipe is end of stream, not a fault: it is how a finished
            // session tells this process the channel is over.
            return Ok(0);
        }
        Ok(read as usize)
    }
}

impl Write for PipeStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let mut written: u32 = 0;
        let ok = unsafe {
            WriteFile(self.0, buffer.as_ptr(), buffer.len() as u32, &mut written, null_mut())
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(written as usize)
    }
    fn flush(&mut self) -> io::Result<()> {
        unsafe { FlushFileBuffers(self.0) };
        Ok(())
    }
}

impl DuplexStream for PipeStream {
    fn duplicate(&self) -> io::Result<Self> {
        let mut duplicated: HANDLE = null_mut();
        let process = unsafe { GetCurrentProcess() };
        let ok = unsafe {
            DuplicateHandle(process, self.0, process, &mut duplicated, 0, 0, DUPLICATE_SAME_ACCESS)
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(PipeStream(duplicated))
    }
    /// A named pipe has no half-close, so the reader is unblocked by cancelling
    /// its outstanding I/O; the handle itself is released when the stream drops.
    fn shutdown(&self) {
        unsafe { CancelIoEx(self.0, null_mut()) };
    }
}
