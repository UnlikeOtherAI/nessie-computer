use super::{admitted_sids, enroll_control_client, wide, CLIENT_ACCESS, PIPE_BUFFER_BYTES};
use crate::{
    control::Control,
    manifest::VerifiedRuntime,
    protocol::Response,
    security::{current_user_sid_string, ConnectedClient, PipeSecurity},
    supervisor::Supervisor,
};
use std::fs;
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
    Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING, PIPE_ACCESS_DUPLEX},
    System::Pipes::{CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT},
};

fn instance(name: &str, security: &mut PipeSecurity) -> HANDLE {
    unsafe {
        CreateNamedPipeW(
            wide(name).as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            2,
            PIPE_BUFFER_BYTES,
            PIPE_BUFFER_BYTES,
            0,
            &security.attributes(),
        )
    }
}

fn control(root: &std::path::Path) -> Control {
    Control::new(Supervisor::new(
        root.to_path_buf(),
        VerifiedRuntime {
            native_helper: root.join("nessie-executor-native.exe"),
            node_executable: root.join("nessie-executor-runtime.exe"),
            root: root.to_path_buf(),
        },
    ))
}

#[test]
fn exact_client_rights_connect_and_the_service_can_create_a_second_instance() {
    let name = format!(r"\\.\pipe\NessieExecutor-test-{}", std::process::id());
    let sid = current_user_sid_string().expect("the test process has a SID");
    let mut first_security = PipeSecurity::new(&[], &sid).expect("a secured pipe descriptor");
    let first = instance(&name, &mut first_security);
    assert_ne!(
        first, INVALID_HANDLE_VALUE,
        "the service SID must create the first instance"
    );
    let client = unsafe {
        CreateFileW(
            wide(&name).as_ptr(),
            CLIENT_ACCESS,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    assert_ne!(
        client, INVALID_HANDLE_VALUE,
        "the tray's exact rights must open the pipe"
    );
    let mut second_security = PipeSecurity::new(&[], &sid).expect("a second secured descriptor");
    let second = instance(&name, &mut second_security);
    assert_ne!(
        second, INVALID_HANDLE_VALUE,
        "the service must retain create-instance access"
    );
    unsafe {
        CloseHandle(client);
        CloseHandle(second);
        CloseHandle(first);
    }
}

#[test]
fn a_service_sid_marker_never_overwrites_its_server_access() {
    let directory = tempfile::tempdir().expect("temporary state root");
    let sid = current_user_sid_string().expect("the test process has a SID");
    fs::create_dir_all(directory.path().join("control-clients")).expect("marker root");
    fs::write(directory.path().join("control-clients").join(&sid), b"").expect("marker");
    assert!(admitted_sids(directory.path()).contains(&sid));
    let mut security = PipeSecurity::new(&admitted_sids(directory.path()), &sid)
        .expect("the duplicated marker is filtered from the server ACE");
    let name = format!(
        r"\\.\pipe\NessieExecutor-duplicate-test-{}",
        std::process::id()
    );
    let first = instance(&name, &mut security);
    assert_ne!(first, INVALID_HANDLE_VALUE);
    let mut second_security = PipeSecurity::new(&admitted_sids(directory.path()), &sid).unwrap();
    let second = instance(&name, &mut second_security);
    assert_ne!(
        second, INVALID_HANDLE_VALUE,
        "the service keeps create-instance access"
    );
    unsafe {
        CloseHandle(second);
        CloseHandle(first);
    }
}

#[test]
fn enrollment_admits_the_independently_observed_login_owner_not_the_approving_administrator() {
    let directory = tempfile::tempdir().expect("temporary state root");
    let control = control(directory.path());
    let own = "S-1-5-21-1004336348-1177238915-682003330-1001";
    let response = enroll_control_client(
        directory.path(),
        &control,
        Some(ConnectedClient {
            is_administrator: true,
            sid: "S-1-5-21-9".to_owned(),
        }),
        Some(own),
    );
    assert_eq!(
        response,
        Response::Ok {
            executors: Vec::new()
        }
    );
    assert!(directory.path().join("control-clients").join(own).is_file());
    assert!(!directory
        .path()
        .join("control-clients")
        .join("S-1-5-21-9")
        .exists());
}

#[test]
fn enrollment_refuses_untrusted_clients_and_a_refusing_service_without_writing() {
    let directory = tempfile::tempdir().expect("temporary state root");
    let control = control(directory.path());
    let client = ConnectedClient {
        is_administrator: false,
        sid: "S-1-5-21-1".to_owned(),
    };
    assert_eq!(
        enroll_control_client(directory.path(), &control, Some(client), None),
        Response::error("An administrator must approve control access for this account."),
    );
    assert!(!directory.path().join("control-clients").exists());
    assert_eq!(
        enroll_control_client(
            directory.path(),
            &control,
            Some(ConnectedClient {
                is_administrator: true,
                sid: "S-1-5-21-9".into()
            }),
            None
        ),
        Response::error(
            "Windows could not verify the signed-in account approved for this connection."
        )
    );
    assert!(!directory.path().join("control-clients").exists());
    let refused =
        Control::Refused("Nessie Computer’s controls need a signed, intact release.".to_owned());
    assert_eq!(
        enroll_control_client(directory.path(), &refused, None, None),
        Response::error("Nessie Computer’s controls need a signed, intact release."),
    );
    assert!(!directory.path().join("control-clients").exists());
}

#[test]
fn runtime_pipe_rejects_pairing_and_status_before_reaching_control() {
    use super::{serve_connection, Scope};
    use std::{
        io::{BufRead, BufReader, Write},
        os::windows::io::FromRawHandle,
    };
    for (index, request) in [
        r#"{"command":"status"}"#,
        r#"{"command":"enrollControlClient"}"#,
        r#"{"command":"managedCustody","operation":{"operation":"status"}}"#,
    ]
    .into_iter()
    .enumerate()
    {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("uncreated-state");
        let sid = current_user_sid_string().unwrap();
        let mut security = PipeSecurity::custody(&sid).unwrap();
        let name = format!(
            r"\\.\pipe\NessieExecutor-custody-test-{}-{index}",
            std::process::id()
        );
        let server = instance(&name, &mut security);
        assert_ne!(server, INVALID_HANDLE_VALUE);
        let client = unsafe {
            CreateFileW(
                wide(&name).as_ptr(),
                CLIENT_ACCESS,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(client, INVALID_HANDLE_VALUE);
        let owned = server as usize;
        let served_root = root.clone();
        let thread = std::thread::spawn(move || {
            let server = owned as HANDLE;
            let connected = unsafe {
                windows_sys::Win32::System::Pipes::ConnectNamedPipe(server, std::ptr::null_mut())
            } != 0
                || unsafe { windows_sys::Win32::Foundation::GetLastError() }
                    == windows_sys::Win32::Foundation::ERROR_PIPE_CONNECTED;
            assert!(connected);
            serve_connection(
                unsafe { crate::pipe_transport::Connection::from_handle(server).unwrap() },
                &served_root,
                &Control::Refused("test readiness refusal".into()),
                Scope::Custody,
                &std::sync::atomic::AtomicBool::new(false),
                std::time::Duration::from_secs(2),
            );
        });
        let mut client = unsafe { fs::File::from_raw_handle(client.cast()) };
        writeln!(client, "{request}").unwrap();
        let mut response = String::new();
        BufReader::new(&client).read_line(&mut response).unwrap();
        drop(client);
        thread.join().unwrap();
        let response: serde_json::Value = serde_json::from_str(&response).unwrap();
        let expected = if index < 2 {
            "This channel accepts runtime admission only."
        } else {
            "test readiness refusal"
        };
        assert_eq!(response["reason"], expected);
        assert!(
            !root.exists(),
            "a runtime pipe request cannot create a control grant"
        );
    }
}
