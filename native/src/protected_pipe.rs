//! Bounded local framing shared by the broker and its retained native child.
fn fail() -> crate::protocol::NativeError {
    crate::protocol::NativeError::new("EXECUTOR_PROTECTED_PIPE_REFUSED")
}
fn wide(path: &std::path::Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
use crate::protocol::NativeError;
use serde_json::Value;
use std::{
    fs::File,
    io::{Read, Write},
    os::windows::io::{AsRawHandle, FromRawHandle},
    path::Path,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        GetLastError, LocalFree, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING, INVALID_HANDLE_VALUE,
    },
    Security::{
        Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SECURITY_ATTRIBUTES,
    },
    Storage::FileSystem::{
        CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
    },
    System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PeekNamedPipe, PIPE_NOWAIT, PIPE_REJECT_REMOTE_CLIENTS,
    },
};

pub const MAX: usize = 65_536;
pub fn instance(name: &str, first: bool, sid: Option<&str>) -> Result<File, NativeError> {
    instance_access(name, first, sid, "0x0012018B")
}
/// Node's pipe open requests FILE_GENERIC_WRITE (including APPEND_DATA). This
/// distinct channel authenticates SYSTEM with the private graph HMAC before
/// any payload and authenticates the graph through the kernel client PID.
/// An injected pipe instance cannot produce that proof. Never use this ACL
/// for pairing, updates, retained consent or the native bootstrap channel.
pub fn execution_companion_instance(first: bool) -> Result<File, NativeError> {
    instance_access(
        nessie_windows_common::execution_creator::COMPANION_PIPE,
        first,
        None,
        "0x0012019F",
    )
}
fn instance_access(
    name: &str,
    first: bool,
    sid: Option<&str>,
    access: &str,
) -> Result<File, NativeError> {
    // Authority comes from the endpoint's kernel-peer/cryptographic checks.
    // Restricted native endpoints also exclude client-created instances.
    let sddl = format!(
        "O:SYG:SYD:P(A;;FA;;;SY)(A;;{access};;;{})",
        sid.unwrap_or("AU")
    );
    let mut descriptor = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(Path::new(&sddl)).as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(fail());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let handle = unsafe {
        CreateNamedPipeW(
            wide(Path::new(name)).as_ptr(),
            PIPE_ACCESS_DUPLEX
                | if first {
                    FILE_FLAG_FIRST_PIPE_INSTANCE
                } else {
                    0
                },
            PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            255,
            (MAX + 4) as u32,
            (MAX + 4) as u32,
            0,
            &attributes,
        )
    };
    unsafe {
        LocalFree(descriptor);
    }
    if handle == INVALID_HANDLE_VALUE {
        return Err(fail());
    }
    Ok(unsafe { File::from_raw_handle(handle) })
}
pub fn connect(file: &File) -> Result<bool, NativeError> {
    let answer = unsafe { ConnectNamedPipe(file.as_raw_handle(), std::ptr::null_mut()) };
    if answer != 0 {
        return Ok(false);
    }
    match unsafe { GetLastError() } {
        ERROR_PIPE_CONNECTED => Ok(true),
        ERROR_PIPE_LISTENING => Ok(false),
        _ => Err(fail()),
    }
}
pub fn client(name: &str) -> Result<File, NativeError> {
    let handle = unsafe {
        CreateFileW(
            wide(Path::new(name)).as_ptr(),
            nessie_windows_common::CONTROL_PIPE_CLIENT_ACCESS,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            0x0010_0000 | 0x0001_0000,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(fail());
    }
    let file = unsafe { File::from_raw_handle(handle) };
    nessie_windows_common::service_channel::verify_updater(
        handle,
        option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"),
    )
    .map_err(|_| fail())?;
    Ok(file)
}
pub fn alive(file: &File) -> bool {
    (unsafe {
        PeekNamedPipe(
            file.as_raw_handle(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    }) != 0
}
pub fn write(file: &mut File, value: &Value) -> Result<(), NativeError> {
    let bytes = serde_json::to_vec(value).map_err(|_| fail())?;
    if bytes.len() > MAX {
        return Err(fail());
    }
    let mut frame = (bytes.len() as u32).to_le_bytes().to_vec();
    frame.extend(bytes);
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut offset = 0;
    while offset < frame.len() {
        if Instant::now() >= deadline {
            return Err(fail());
        }
        match file.write(&frame[offset..]) {
            Ok(0) => std::thread::sleep(Duration::from_millis(5)),
            Ok(n) => offset += n,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5))
            }
            Err(_) => return Err(fail()),
        }
    }
    Ok(())
}
pub struct Reader {
    size: Option<usize>,
}
impl Reader {
    pub fn new() -> Self {
        Self { size: None }
    }
    pub fn poll(&mut self, file: &mut File) -> Result<Option<Value>, NativeError> {
        let mut available = 0;
        if unsafe {
            PeekNamedPipe(
                file.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(fail());
        }
        if self.size.is_none() && available >= 4 {
            let mut bytes = [0; 4];
            file.read_exact(&mut bytes).map_err(|_| fail())?;
            let size = u32::from_le_bytes(bytes) as usize;
            if size == 0 || size > MAX {
                return Err(fail());
            }
            self.size = Some(size);
            available -= 4;
        }
        if let Some(size) = self.size.filter(|s| available as usize >= *s) {
            let mut bytes = vec![0; size];
            file.read_exact(&mut bytes).map_err(|_| fail())?;
            self.size = None;
            return Ok(Some(serde_json::from_slice(&bytes).map_err(|_| fail())?));
        }
        Ok(None)
    }
    pub fn read(&mut self, file: &mut File, deadline: Instant) -> Result<Value, NativeError> {
        while Instant::now() < deadline {
            if let Some(v) = self.poll(file)? {
                return Ok(v);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Err(fail())
    }
}
