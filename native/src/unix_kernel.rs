//! Small kernel differences shared by the Unix custody implementations.
use crate::protocol::NativeError;

pub fn cloexec_pipe() -> Result<[i32; 2], NativeError> {
    let mut pipe = [-1; 2];
    #[cfg(target_os = "linux")]
    let success = unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC) } == 0;
    #[cfg(target_os = "macos")]
    let success = unsafe {
        libc::pipe(pipe.as_mut_ptr()) == 0
            && libc::fcntl(pipe[0], libc::F_SETFD, libc::FD_CLOEXEC) == 0
            && libc::fcntl(pipe[1], libc::F_SETFD, libc::FD_CLOEXEC) == 0
    };
    if !success {
        for descriptor in pipe { if descriptor >= 0 { unsafe { libc::close(descriptor); } } }
        return Err(NativeError::new("EXECUTOR_KERNEL_PIPE_REJECTED"));
    }
    Ok(pipe)
}

pub unsafe fn errno_address() -> *mut i32 {
    #[cfg(target_os = "linux")]
    { libc::__errno_location() }
    #[cfg(target_os = "macos")]
    { libc::__error() }
}
