use super::*;
use std::{fs::File, io::Write, os::windows::io::FromRawHandle};
use windows_sys::Win32::System::Pipes::{SetNamedPipeHandleState, PIPE_NOWAIT};

static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
fn name() -> String {
    format!(
        r"\\.\pipe\NessieLifecycle-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn client(name: &str) -> Option<File> {
    let handle = unsafe {
        CreateFileW(
            wide(name).as_ptr(),
            CLIENT_ACCESS,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return None;
    }
    let file = unsafe { File::from_raw_handle(handle.cast()) };
    let mode = PIPE_NOWAIT;
    assert_ne!(
        unsafe { SetNamedPipeHandleState(handle, &mode, std::ptr::null(), std::ptr::null()) },
        0
    );
    Some(file)
}

fn connect(name: &str) -> File {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(file) = client(name) {
            return file;
        }
        assert!(Instant::now() < deadline, "pipe must become available");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn response(file: &File) -> String {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        assert!(Instant::now() < deadline, "response deadline");
        match nessie_windows_common::pipe_io::read(file, &mut buffer) {
            Ok(count) if count > 0 => {
                bytes.extend_from_slice(&buffer[..count]);
                if bytes.contains(&b'\n') {
                    return String::from_utf8(bytes).unwrap();
                }
            }
            Err(error)
                if error.raw_os_error()
                    == Some(windows_sys::Win32::Foundation::ERROR_NO_DATA as i32) => {}
            other => panic!("pipe closed before reply: {other:?}"),
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn connected(root: &Path) -> (Connection, File) {
    let name = name();
    let server = create_instance(root, Scope::Custody, &name).unwrap();
    let client = connect(&name);
    assert_eq!(
        unsafe { ConnectNamedPipe(server.handle(), std::ptr::null_mut()) },
        0
    );
    assert_eq!(unsafe { GetLastError() }, ERROR_PIPE_CONNECTED);
    (server, client)
}

#[test]
fn empty_and_partial_requests_expire_and_unread_replies_cannot_hold_a_worker() {
    let root = tempfile::tempdir().unwrap();
    let stopped = AtomicBool::new(false);
    for request in [b"".as_slice(), b"{\"command\":".as_slice()] {
        let (server, mut client) = connected(root.path());
        client.write_all(request).unwrap();
        let started = Instant::now();
        assert!(server
            .request(1024, started + Duration::from_millis(100), &stopped)
            .is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }
    // Both a full output buffer and a queued small reply used to block forever
    // in WriteFile / FlushFileBuffers when the peer kept its handle open.
    for size in [64, (PIPE_BUFFER_BYTES * 2) as usize] {
        let (mut server, _client) = connected(root.path());
        let started = Instant::now();
        server.reply(
            &vec![b'x'; size],
            started + Duration::from_millis(100),
            &stopped,
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}

#[test]
fn shutdown_interrupts_transport_and_request_size_stays_bounded() {
    let root = tempfile::tempdir().unwrap();
    let (mut server, mut client) = connected(root.path());
    client.write_all(b"123456789\n").unwrap();
    assert!(server
        .request(
            8,
            Instant::now() + Duration::from_secs(10),
            &AtomicBool::new(false)
        )
        .is_none());
    let started = Instant::now();
    let stopped = AtomicBool::new(true);
    assert!(server
        .request(1024, started + Duration::from_secs(60), &stopped)
        .is_none());
    server.reply(b"reply\n", started + Duration::from_secs(60), &stopped);
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn custody_saturation_is_bounded_control_stays_responsive_and_custody_recovers() {
    let root = tempfile::tempdir().unwrap();
    let custody_name = name();
    let control_name = name();
    let shutdown = Arc::new(AtomicBool::new(false));
    let mut threads = Vec::new();
    for (scope, name) in [
        (Scope::Custody, custody_name.clone()),
        (Scope::Control, control_name.clone()),
    ] {
        let root = root.path().to_owned();
        let stopped = Arc::clone(&shutdown);
        threads.push(std::thread::spawn(move || {
            serve_channel(
                root,
                Arc::new(Control::Refused("fixture ready".into())),
                stopped,
                scope,
                &name,
                Duration::from_secs(2),
            )
        }));
    }
    let run = std::panic::catch_unwind(|| {
        let clients = (0..MAX_CONNECTIONS)
            .map(|_| connect(&custody_name))
            .collect::<Vec<_>>();
        assert!(
            client(&custody_name).is_none(),
            "never admit worker number 17"
        );
        let mut control = connect(&control_name);
        control.write_all(b"{\"command\":\"status\"}\n").unwrap();
        assert!(response(&control).contains("fixture ready"));
        drop(control);
        // Keep every stalled client open. Recovery must come from the server's
        // deadline, not test-side cleanup or a service restart.
        let mut recovered = connect(&custody_name);
        recovered
            .write_all(
                b"{\"command\":\"managedCustody\",\"operation\":{\"operation\":\"status\"}}\n",
            )
            .unwrap();
        assert!(response(&recovered).contains("fixture ready"));
        assert!(!shutdown.load(Ordering::Acquire));
        drop(clients);
    });
    shutdown.store(true, Ordering::Release);
    for thread in threads {
        thread.join().unwrap();
    }
    run.unwrap();
}

#[test]
fn permits_return_on_drop_without_affecting_the_other_channel() {
    let custody = Slots::new(2);
    let control = Slots::new(2);
    let first = custody.acquire().unwrap();
    let _second = custody.acquire().unwrap();
    assert!(custody.acquire().is_none());
    assert!(control.acquire().is_some());
    drop(first);
    assert!(custody.acquire().is_some());
}
