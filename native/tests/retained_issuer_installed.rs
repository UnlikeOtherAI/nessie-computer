//! Run only against an explicitly prepared, signed fixture ceremony. No prompts,
//! process mutations or credential reads are performed by this probe.
#[cfg(windows)]
#[test]
fn held_issuer_denies_daemon_process_and_private_key_access() {
    use nessie_windows_common::process::Process;
    use windows_sys::Win32::{Foundation::{CloseHandle,GetLastError,INVALID_HANDLE_VALUE},System::{
        Threading::{OpenProcess,OpenProcessToken,OpenThread,GetProcessIdOfThread},
        Diagnostics::ToolHelp::{CreateToolhelp32Snapshot,Thread32First,Thread32Next,TH32CS_SNAPTHREAD,THREADENTRY32}}};
    let pid=std::env::var("NESSIE_T3_TEST_CEREMONY_PID").expect("explicit fixture ceremony PID required").parse().unwrap();
    let expected_start=std::env::var("NESSIE_T3_TEST_CEREMONY_STARTED_AT").expect("exact kernel generation required");
    let expected_sha=std::env::var("NESSIE_T3_TEST_NATIVE_SHA256").expect("exact signed fixture helper hash required");
    let own=Process::open(std::process::id()).unwrap();assert!(!own.elevated && own.sid!="S-1-5-18");
    let target=Process::open(pid).expect("fixture child must be queryable");
    assert_eq!(target.generation.started_at,expected_start);assert_eq!(target.sid,own.sid);
    assert_eq!(target.session,own.session);assert!(target.alive());
    assert_eq!(target.image.file_name().unwrap(),"nessie-executor-native.exe");
    target.signed(option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU")).expect("actual signed fixture helper");
    use sha2::{Sha256,Digest};
    let mut file=std::fs::File::open(&target.image).unwrap();let mut digest=Sha256::new();
    let mut bytes=[0;65536];use std::io::Read;
    loop {let n=file.read(&mut bytes).unwrap();if n==0 {break;}digest.update(&bytes[..n]);}
    assert_eq!(format!("{:x}",digest.finalize()),expected_sha);
    // Each dangerous right is denied individually, not just a broad mask.
    for access in [0x0002,0x0008,0x0020,0x0040,0x0004_0000,0x0008_0000] {
        let handle=unsafe {OpenProcess(access,0,pid)};let error=unsafe {GetLastError()};
        if !handle.is_null() {unsafe {CloseHandle(handle);}}
        assert!(handle.is_null(),"ordinary owner acquired process right {access:x}");assert_eq!(error,5);
    }
    // A same-user token handle must not permit default-DACL reset or duplication.
    for access in [0x0002,0x0080,0x0004_0000,0x0008_0000] {
        let mut handle=std::ptr::null_mut();
        let result=unsafe {OpenProcessToken(target.handle.0,access,&mut handle)};
        let error=unsafe {GetLastError()};if !handle.is_null() {unsafe {CloseHandle(handle);}}
        assert_eq!(result,0,"ordinary owner acquired token right {access:x}");assert_eq!(error,5);
    }
    let snapshot=unsafe {CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD,0)};assert_ne!(snapshot,INVALID_HANDLE_VALUE);
    let snapshot=nessie_windows_common::process::Owned(snapshot);
    let mut entry:THREADENTRY32=unsafe {std::mem::zeroed()};entry.dwSize=std::mem::size_of::<THREADENTRY32>() as u32;
    let mut more=unsafe {Thread32First(snapshot.0,&mut entry)}!=0;let mut checked=0;
    while more {
        if entry.th32OwnerProcessID==pid {
            let thread=unsafe {OpenThread(0x0800|0x0010_0000,0,entry.th32ThreadID)};
            assert!(!thread.is_null(),"fixture thread must remain live while probing");
            let thread=nessie_windows_common::process::Owned(thread);
            assert_eq!(unsafe {GetProcessIdOfThread(thread.0)},pid);
            for access in [0x0002,0x0010,0x0080,0x0100,0x0200,0x0004_0000,0x0008_0000] {
                let handle=unsafe {OpenThread(access,0,entry.th32ThreadID)};let error=unsafe {GetLastError()};
                if !handle.is_null() {unsafe {CloseHandle(handle);}}
                assert!(handle.is_null(),"ordinary owner acquired thread right {access:x}");assert_eq!(error,5);
            }
            checked+=1;
        }
        more=unsafe {Thread32Next(snapshot.0,&mut entry)}!=0;
    }
    assert!(checked>=2,"probe must cover the primary and at least one later native thread");
    let root=nessie_windows_common::update_admission::root().unwrap().join("retained-import-issuers");
    let error=std::fs::read_dir(root).expect_err("ordinary owner must not enumerate private issuer seeds");
    assert_eq!(error.raw_os_error(),Some(5),"missing fixture key store is not a denial pass");
    assert!(target.alive());
}
