//! Read-only installed diagnostics; never grants authority or changes local policy.
#[cfg(windows)]
fn main() {
    if std::env::args().any(|value| value == "--installed-facts") {
        inspect_installation();
        return;
    }
    if std::env::args().any(|value| value == "--peer-facts") {
        inspect_peer();
        std::process::exit(1);
    }
    let result = nessie_windows_common::update_channel::inspect_status(option_env!(
        "NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"
    ));
    match result {
        Ok(status) => println!("{status}"),
        Err(reason) => {
            eprintln!(
                "{}",
                serde_json::to_string(&reason).expect("closed diagnostic fields serialize")
            );
            std::process::exit(1);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("This installed-status diagnostic requires Windows.");
    std::process::exit(2);
}

// These independent read-only API probes never substitute for call() verification.
#[cfg(windows)]
fn inspect_peer() {
    use std::{
        ffi::OsStr,
        os::windows::ffi::{OsStrExt, OsStringExt},
        path::PathBuf,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE},
        Security::{
            GetTokenInformation, IsWellKnownSid, TokenSessionId, TokenUser, WinLocalSystemSid,
            TOKEN_QUERY, TOKEN_USER,
        },
        Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING},
        System::{
            Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW},
            Threading::{
                OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            },
        },
    };
    let name: Vec<u16> = OsStr::new(nessie_windows_common::update_channel::PIPE)
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        WaitNamedPipeW(name.as_ptr(), 5000);
    }
    let pipe = unsafe {
        CreateFileW(
            name.as_ptr(),
            nessie_windows_common::CONTROL_PIPE_CLIENT_ACCESS,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if pipe.is_null() || pipe == INVALID_HANDLE_VALUE {
        eprintln!(
            "{}",
            serde_json::json!({"pipeOpenError":unsafe { GetLastError() }})
        );
        return;
    }
    let mut pid = 0;
    let pid_ok = unsafe { GetNamedPipeServerProcessId(pipe, &mut pid) };
    let mut facts = serde_json::json!({"diagnosticOnly":true,"pipePidOk":pid_ok != 0,"pid":pid});
    let retained = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    facts["processWithSynchronizeError"] = serde_json::json!(if retained.is_null() {
        unsafe { GetLastError() }
    } else {
        0
    });
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    facts["processLimitedError"] = serde_json::json!(if process.is_null() {
        unsafe { GetLastError() }
    } else {
        0
    });
    if !process.is_null() {
        let mut token = std::ptr::null_mut();
        let opened = unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) };
        facts["tokenQueryError"] = serde_json::json!(if opened == 0 {
            unsafe { GetLastError() }
        } else {
            0
        });
        if opened != 0 {
            let mut session = u32::MAX;
            let mut size = 0;
            let session_ok = unsafe {
                GetTokenInformation(
                    token,
                    TokenSessionId,
                    (&mut session as *mut u32).cast(),
                    std::mem::size_of::<u32>() as u32,
                    &mut size,
                )
            };
            facts["sessionOk"] = serde_json::json!(session_ok != 0);
            facts["session"] = serde_json::json!(session);
            unsafe {
                GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
            }
            let mut bytes = vec![0_u8; size as usize];
            if !bytes.is_empty()
                && unsafe {
                    GetTokenInformation(
                        token,
                        TokenUser,
                        bytes.as_mut_ptr().cast(),
                        size,
                        &mut size,
                    )
                } != 0
            {
                facts["system"] = serde_json::json!(
                    unsafe {
                        IsWellKnownSid(
                            (*bytes.as_ptr().cast::<TOKEN_USER>()).User.Sid,
                            WinLocalSystemSid,
                        )
                    } != 0
                );
            }
            unsafe {
                CloseHandle(token);
            }
        }
        let mut image = vec![0_u16; 32_768];
        let mut size = image.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process, 0, image.as_mut_ptr(), &mut size) } != 0 {
            let path = PathBuf::from(std::ffi::OsString::from_wide(&image[..size as usize]));
            facts["image"] = serde_json::json!(path);
            let pin = option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");
            facts["publisher"] =
                serde_json::json!(nessie_windows_provenance::decide_release_signature(
                    pin,
                    nessie_windows_provenance::collect_signature_facts(&path)
                ));
            facts["protectedImage"] =
                serde_json::json!(nessie_windows_common::update_runtime::pin_image(&path, pin)
                    .map(|_| ())
                    .map_err(|value| value.to_string()));
        }
        unsafe {
            CloseHandle(process);
        }
    }
    if !retained.is_null() {
        unsafe {
            CloseHandle(retained);
        }
    }
    unsafe {
        CloseHandle(pipe);
    }
    eprintln!("{facts}");
}

// Read-only timings isolate OS provenance work from the broker's transport.
#[cfg(windows)]
fn inspect_installation() {
    use nessie_windows_common::{release, update_admission::known_folder};
    use std::time::Instant;
    use windows_sys::Win32::UI::Shell::{
        FOLDERID_ProgramData, FOLDERID_ProgramFiles, FOLDERID_Windows,
    };
    let start = Instant::now();
    for (name, id) in [
        ("windows", &FOLDERID_Windows),
        ("programData", &FOLDERID_ProgramData),
        ("programFiles", &FOLDERID_ProgramFiles),
    ] {
        eprintln!(
            "{}",
            serde_json::json!({"diagnosticOnly":true,"starting":name})
        );
        eprintln!(
            "{}",
            serde_json::json!({"stage":name,"elapsedMs":start.elapsed().as_millis(),
            "result":known_folder(id)})
        );
    }
    let Ok(program_files) = known_folder(&FOLDERID_ProgramFiles) else {
        return;
    };
    let path = program_files.join("Nessie Executor/nessie-executor-native.exe");
    let pin = option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");
    eprintln!(
        "{}",
        serde_json::json!({"diagnosticOnly":true,"starting":"installed_runtime"})
    );
    match release::load_at(&path, pin) {
        Ok(mut installed) => {
            eprintln!(
                "{}",
                serde_json::json!({"stage":"installed_runtime","elapsedMs":start.elapsed().as_millis(),
                "version":installed.version,"sourceCommit":installed.source_commit})
            );
            eprintln!("{}", serde_json::json!({"starting":"launch_consumers"}));
            let result = installed.verify_launch_consumers(pin);
            eprintln!(
                "{}",
                serde_json::json!({"stage":"launch_consumers", "elapsedMs":start.elapsed().as_millis(),"result":result})
            );
        }
        Err(reason) => eprintln!(
            "{}",
            serde_json::json!({"stage":"installed_runtime", "elapsedMs":start.elapsed().as_millis(),"error":reason})
        ),
    }
}
