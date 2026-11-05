//! The `AF_HYPERV` half. Windows only.
//!
//! "In contrast to the socket address (sockaddr) for a standard Internet
//! Protocol address family (AF_INET) ... the socket address for AF_HYPERV uses
//! the virtual machine's ID and the application ID" — and for a Linux guest
//! that application id is not free to choose: Microsoft defines one VSOCK
//! template GUID whose first field is the guest's `svm_port`, so the service id
//! is decided by the port (see `args::vsock_service_guid`). The MSI registers
//! each of those GUIDs under `GuestCommunicationServices`, which is what makes
//! the socket openable at all.

use std::io::{self, Read, Write};
use std::mem::size_of;
use std::os::windows::io::{FromRawSocket, IntoRawSocket};

use windows_sys::Win32::Networking::WinSock::{
    accept, bind, closesocket, listen, recv, send, shutdown, socket, WSAGetLastError, WSAStartup,
    INVALID_SOCKET, SD_BOTH, SOCKET, SOCKET_ERROR, SOCK_STREAM, WSADATA,
};

use crate::pump::DuplexStream;

/// `AF_HYPERV` and `HV_PROTOCOL_RAW` from `hvsocket.h`; `windows-sys` does not
/// generate either, so they are declared once here rather than in each caller.
const AF_HYPERV: u16 = 34;
const HV_PROTOCOL_RAW: i32 = 1;
const LISTEN_BACKLOG: i32 = 4;

#[repr(C)]
#[derive(Clone, Copy)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

/// `SOCKADDR_HV`: family, one reserved field, then the two GUIDs.
#[repr(C)]
#[derive(Clone, Copy)]
struct SockaddrHv {
    family: u16,
    reserved: u16,
    vm_id: Guid,
    service_id: Guid,
}

fn parse_guid(value: &str) -> io::Result<Guid> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidInput, "malformed guid");
    let parts: Vec<&str> = value.split('-').collect();
    if parts.len() != 5 {
        return Err(invalid());
    }
    let data1 = u32::from_str_radix(parts[0], 16).map_err(|_| invalid())?;
    let data2 = u16::from_str_radix(parts[1], 16).map_err(|_| invalid())?;
    let data3 = u16::from_str_radix(parts[2], 16).map_err(|_| invalid())?;
    let tail = format!("{}{}", parts[3], parts[4]);
    if tail.len() != 16 {
        return Err(invalid());
    }
    let mut data4 = [0u8; 8];
    for (index, slot) in data4.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&tail[index * 2..index * 2 + 2], 16).map_err(|_| invalid())?;
    }
    Ok(Guid { data1, data2, data3, data4 })
}

fn last_error() -> io::Error {
    io::Error::from_raw_os_error(unsafe { WSAGetLastError() })
}

pub fn start_winsock() -> io::Result<()> {
    let mut data: WSADATA = unsafe { std::mem::zeroed() };
    // 2.2, the version every current Windows provides.
    if unsafe { WSAStartup(0x0202, &mut data) } != 0 {
        return Err(io::Error::other("winsock is unavailable"));
    }
    Ok(())
}

/// One `AF_HYPERV` connection, owned. Read and write go through `recv`/`send`
/// because a Hyper-V socket is a socket, not a file handle.
pub struct HvStream(SOCKET);

impl HvStream {
    fn duplicate_socket(&self) -> io::Result<Self> {
        // The socket is duplicated as a file descriptor rather than through
        // WSADuplicateSocket: both halves live in this process, and every
        // handle is closed when the session ends.
        let owned = unsafe { std::os::windows::io::OwnedSocket::from_raw_socket(self.0 as _) };
        let cloned = owned.try_clone();
        let _ = owned.into_raw_socket();
        Ok(Self(cloned?.into_raw_socket() as SOCKET))
    }
}

impl Drop for HvStream {
    fn drop(&mut self) {
        unsafe { closesocket(self.0) };
    }
}

impl Read for HvStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = unsafe { recv(self.0, buffer.as_mut_ptr(), buffer.len() as i32, 0) };
        if read == SOCKET_ERROR {
            return Err(last_error());
        }
        Ok(read as usize)
    }
}

impl Write for HvStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let written = unsafe { send(self.0, buffer.as_ptr(), buffer.len() as i32, 0) };
        if written == SOCKET_ERROR {
            return Err(last_error());
        }
        Ok(written as usize)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl DuplexStream for HvStream {
    fn duplicate(&self) -> io::Result<Self> {
        self.duplicate_socket()
    }
    fn shutdown(&self) {
        unsafe { shutdown(self.0, SD_BOTH) };
    }
}

fn new_socket() -> io::Result<SOCKET> {
    let handle = unsafe { socket(AF_HYPERV as i32, SOCK_STREAM, HV_PROTOCOL_RAW) };
    if handle == INVALID_SOCKET {
        return Err(last_error());
    }
    Ok(handle)
}

fn address(vm_id: &str, service_guid: &str) -> io::Result<SockaddrHv> {
    Ok(SockaddrHv {
        family: AF_HYPERV,
        reserved: 0,
        vm_id: parse_guid(vm_id)?,
        service_id: parse_guid(service_guid)?,
    })
}

/// Listens for connections the *guest* opens. This is the direction both of
/// Nessie's channels use, the same way both arrive on a host Unix socket under
/// Firecracker.
pub struct HvListener(SOCKET);

impl Drop for HvListener {
    fn drop(&mut self) {
        unsafe { closesocket(self.0) };
    }
}

impl HvListener {
    pub fn bind(vm_id: &str, service_guid: &str) -> io::Result<Self> {
        let handle = new_socket()?;
        let bound = address(vm_id, service_guid)?;
        let result = unsafe {
            bind(
                handle,
                (&bound as *const SockaddrHv).cast(),
                size_of::<SockaddrHv>() as i32,
            )
        };
        if result == SOCKET_ERROR {
            unsafe { closesocket(handle) };
            return Err(last_error());
        }
        if unsafe { listen(handle, LISTEN_BACKLOG) } == SOCKET_ERROR {
            unsafe { closesocket(handle) };
            return Err(last_error());
        }
        Ok(Self(handle))
    }

    pub fn accept(&self) -> io::Result<HvStream> {
        let accepted = unsafe { accept(self.0, std::ptr::null_mut(), std::ptr::null_mut()) };
        if accepted == INVALID_SOCKET {
            return Err(last_error());
        }
        Ok(HvStream(accepted))
    }
}

/// Dials the guest. Nothing in a session uses this — both channels are
/// guest-initiated — and it exists for the same reason Firecracker's
/// host-initiated framing does: so the transport is complete rather than
/// half-implemented.
pub fn connect(vm_id: &str, service_guid: &str) -> io::Result<HvStream> {
    let handle = new_socket()?;
    let target = address(vm_id, service_guid)?;
    let result = unsafe {
        windows_sys::Win32::Networking::WinSock::connect(
            handle,
            (&target as *const SockaddrHv).cast(),
            size_of::<SockaddrHv>() as i32,
        )
    };
    if result == SOCKET_ERROR {
        unsafe { closesocket(handle) };
        return Err(last_error());
    }
    Ok(HvStream(handle))
}
