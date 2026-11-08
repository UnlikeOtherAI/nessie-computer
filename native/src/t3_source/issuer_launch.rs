//! SYSTEM creates the ceremony process with no user write/debug/duplicate access.
//! A matching image path is insufficient: the broker retains this exact child.
use super::{handles::{fail,wide},consent_peer::PIN};
use crate::protocol::NativeError;
use nessie_windows_common::{process::{Process,Owned},release::Release};
use std::{path::Path,mem::size_of};
use windows_sys::Win32::{Foundation::LocalFree,
    Security::{SECURITY_ATTRIBUTES,Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW},
    System::{RemoteDesktop::WTSQueryUserToken,Threading::{CreateProcessAsUserW,TerminateProcess,
        CREATE_UNICODE_ENVIRONMENT,CREATE_SUSPENDED,PROCESS_INFORMATION,STARTUPINFOW,ResumeThread}}};

pub struct Child { pub process:Process,handle:Owned }
impl Drop for Child {fn drop(&mut self) {unsafe {TerminateProcess(self.handle.0,1);}}}
pub fn launch(release:&Release,tray:&Process,nonce:&str)->Result<Child,NativeError> {
    if !super::consent_contract::hex_id(nonce) || !tray.alive() {return Err(fail());}
    nessie_windows_common::process::interactive(tray).map_err(|_|fail())?;
    let mut token=std::ptr::null_mut();
    if unsafe {WTSQueryUserToken(tray.session,&mut token)}==0 {return Err(fail());}
    let token=Owned(token);
    // WTS must still identify this exact source owner, not a newly logged-in user.
    if nessie_windows_common::process::session_owner(tray.session).map_err(|_|fail())?!=tray.sid {return Err(fail());}
    let windows=nessie_windows_common::update_admission::known_folder(
        &windows_sys::Win32::UI::Shell::FOLDERID_Windows).map_err(|_|fail())?;
    let mut descriptor=std::ptr::null_mut();
    // SYSTEM owns both objects. AU gets query/synchronize only. In particular,
    // no VM_WRITE, CREATE_THREAD, DUP_HANDLE, SET_INFORMATION, WRITE_DAC or OWNER.
    if unsafe {ConvertStringSecurityDescriptorToSecurityDescriptorW(
        wide(Path::new("O:SYG:SYD:P(A;;GA;;;SY)(A;;0x00101000;;;AU)")).as_ptr(),1,
        &mut descriptor,std::ptr::null_mut())}==0 {return Err(fail());}
    let attributes=SECURITY_ATTRIBUTES {nLength:size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor:descriptor,bInheritHandle:0};
    let executable=&release.runtime.native_helper;
    let image=wide(executable);
    let mut arguments=wide(Path::new(&format!("\"{}\" t3-retained-approve {nonce}",executable.display())));
    let mut desktop=wide(Path::new("winsta0\\default"));
    let mut environment=wide(Path::new(&format!("SystemRoot={}",windows.display())));environment.push(0);
    let directory=wide(&release.runtime.root);
    let mut startup:STARTUPINFOW=unsafe {std::mem::zeroed()};startup.cb=size_of::<STARTUPINFOW>() as u32;
    startup.lpDesktop=desktop.as_mut_ptr();
    let mut created:PROCESS_INFORMATION=unsafe {std::mem::zeroed()};
    let started=unsafe {CreateProcessAsUserW(token.0,image.as_ptr(),arguments.as_mut_ptr(),&attributes,&attributes,
        0,CREATE_UNICODE_ENVIRONMENT|CREATE_SUSPENDED|0x0800_0000,environment.as_mut_ptr().cast(),
        directory.as_ptr(),&startup,&mut created)};
    unsafe {LocalFree(descriptor);}
    if started==0 {return Err(fail());}
    let handle=Owned(created.hProcess);let thread=Owned(created.hThread);
    let result=(|| {
        let process=Process::open(created.dwProcessId).map_err(|_|fail())?;
        if process.sid!=tray.sid || process.session!=tray.session || process.elevated
            || process.image!=*executable || !tray.alive() {return Err(fail());}
        process.signed(PIN).map_err(|_|fail())?;
        if unsafe {ResumeThread(thread.0)}==u32::MAX {return Err(fail());}Ok(process)
    })();
    match result {Ok(process)=>Ok(Child {process,handle}),Err(e)=>{unsafe {TerminateProcess(handle.0,1);}Err(e)}}
}
