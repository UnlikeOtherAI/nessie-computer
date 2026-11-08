//! Preserve Win32 nonblocking-pipe errors instead of treating no-data as EOF.
use std::{fs::File, io, os::windows::io::AsRawHandle};
use windows_sys::Win32::Storage::FileSystem::ReadFile;

/// The caller retains the handle and owns the nonblocking mode/deadline.
/// std::fs::File maps ERROR_NO_DATA (BrokenPipe) to Ok(0), which is not EOF
/// for an empty PIPE_NOWAIT connection while the client authenticates its peer.
pub fn read(pipe: &File, buffer: &mut [u8]) -> io::Result<usize> {
    let length = buffer.len().min(u32::MAX as usize) as u32;
    let mut received = 0;
    let success = unsafe {
        ReadFile(
            pipe.as_raw_handle().cast(),
            buffer.as_mut_ptr().cast(),
            length,
            &mut received,
            std::ptr::null_mut(),
        )
    };
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(received as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, os::windows::io::FromRawHandle};
    use windows_sys::Win32::{
        Foundation::{
            GetLastError, ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_CONNECTED,
            INVALID_HANDLE_VALUE,
        },
        Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
        },
        System::Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, SetNamedPipeHandleState, PIPE_NOWAIT,
            PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
        },
    };

    #[test]
    fn an_empty_connected_pipe_survives_until_the_request_and_reply_arrive() {
        let name: Vec<u16> = format!(r"\\.\pipe\NessiePipeReadTest-{}", std::process::id())
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let server = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                4096,
                4096,
                0,
                std::ptr::null(),
            )
        };
        assert_ne!(server, INVALID_HANDLE_VALUE);
        let mut server = unsafe { File::from_raw_handle(server.cast()) };
        let client = unsafe {
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
        assert_ne!(client, INVALID_HANDLE_VALUE);
        let mut client = unsafe { File::from_raw_handle(client.cast()) };
        assert_eq!(
            unsafe { ConnectNamedPipe(server.as_raw_handle().cast(), std::ptr::null_mut()) },
            0
        );
        assert_eq!(unsafe { GetLastError() }, ERROR_PIPE_CONNECTED);
        let mode = PIPE_NOWAIT;
        assert_ne!(
            unsafe {
                SetNamedPipeHandleState(
                    client.as_raw_handle().cast(),
                    &mode,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            },
            0
        );
        let mut bytes = [0_u8; 128];
        assert_eq!(
            read(&server, &mut bytes).unwrap_err().raw_os_error(),
            Some(ERROR_NO_DATA as i32)
        );
        client.write_all(b"{\"operation\":\"status\"}\n").unwrap();
        let received = read(&server, &mut bytes).unwrap();
        assert_eq!(&bytes[..received], b"{\"operation\":\"status\"}\n");
        assert_eq!(
            read(&client, &mut bytes).unwrap_err().raw_os_error(),
            Some(ERROR_NO_DATA as i32)
        );
        server.write_all(b"{\"format\":1}\n").unwrap();
        let received = read(&client, &mut bytes).unwrap();
        assert_eq!(&bytes[..received], b"{\"format\":1}\n");
        drop(client);
        assert_eq!(
            read(&server, &mut bytes).unwrap_err().raw_os_error(),
            Some(ERROR_BROKEN_PIPE as i32)
        );
    }
}
