//! Verify the operating system's actual broker peer before sending a fixed request.
use nessie_executor_updater::protocol::Request;
#[cfg(unix)]
use std::io::{BufRead, BufReader, Read, Write};

pub const REJECTED: &str = "update.coordinator_unavailable";

#[cfg(target_os = "linux")]
pub const SOCKET: &str = "/var/lib/nessie-executor/update-control.sock";
#[cfg(target_os = "macos")]
pub const SOCKET: &str = "/Library/Application Support/Nessie Executor/update-control.sock";
#[cfg(windows)]
pub const PIPE: &str = nessie_windows_common::update_channel::PIPE;

#[cfg(unix)]
fn exchange(mut stream: impl Read + Write, request: &Request) -> Result<serde_json::Value, String> {
    let mut bytes = serde_json::to_vec(request).map_err(|_| REJECTED)?;
    bytes.push(b'\n');
    stream
        .write_all(&bytes)
        .and_then(|()| stream.flush())
        .map_err(|_| REJECTED)?;
    let mut response = Vec::new();
    BufReader::new(stream.take(16_385))
        .read_until(b'\n', &mut response)
        .map_err(|_| REJECTED)?;
    if response.len() > 16_384 || !response.ends_with(b"\n") {
        return Err(REJECTED.into());
    }
    let value: serde_json::Value = serde_json::from_slice(&response).map_err(|_| REJECTED)?;
    if value.get("error").is_some() {
        return Err(REJECTED.into());
    }
    Ok(value)
}

#[cfg(unix)]
pub fn call(request: &Request) -> Result<serde_json::Value, String> {
    use std::{
        fs,
        os::{
            fd::AsRawFd,
            unix::{
                fs::{FileTypeExt, MetadataExt},
                net::UnixStream,
            },
        },
        time::Duration,
    };
    let entry = fs::symlink_metadata(SOCKET).map_err(|_| REJECTED)?;
    if !entry.file_type().is_socket() || entry.uid() != 0 {
        return Err(REJECTED.into());
    }
    let stream = UnixStream::connect(SOCKET).map_err(|_| REJECTED)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| REJECTED)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| REJECTED)?;
    #[cfg(target_os = "linux")]
    {
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut size,
            )
        } != 0
            || size as usize != std::mem::size_of::<libc::ucred>()
            || credentials.uid != 0
        {
            return Err(REJECTED.into());
        }
    }
    #[cfg(target_os = "macos")]
    {
        let mut uid = u32::MAX;
        let mut gid = u32::MAX;
        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 || uid != 0 {
            return Err(REJECTED.into());
        }
    }
    exchange(stream, request)
}

#[cfg(windows)]
pub fn call(request: &Request) -> Result<serde_json::Value, String> {
    nessie_windows_common::update_channel::call(
        &serde_json::to_value(request).map_err(|_| REJECTED)?,
        option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"),
    )
}
