//! SYSTEM creates the ceremony process with no user write/debug/duplicate access.
//! A matching image path is insufficient: the broker retains this exact child.
use super::{handles::{fail,wide},consent_peer::PIN};
use crate::protocol::NativeError;
use nessie_windows_common::{process::{Process,Owned},release::Release};
use std::{path::Path,mem::size_of};
use windows_sys::Win32::{Foundation::LocalFree,
    Security::{SECURITY_ATTRIBUTES,Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW},
    System::{RemoteDesktop::WTSQueryUserToken,Threading::{CreateProcessAsUserW,TerminateProcess,
        CREATE_UNICODE_ENVIRONMENT,CREATE_SUSPENDED,PROCESS_INFORMATION,STARTUPINFOW,STARTUPINFOEXW,ResumeThread,
        InitializeProcThreadAttributeList,UpdateProcThreadAttribute,DeleteProcThreadAttributeList,
        EXTENDED_STARTUPINFO_PRESENT,PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY,
        GetProcessMitigationPolicy,ProcessSignaturePolicy,ProcessExtensionPointDisablePolicy}}};

pub struct Child { pub process:Process,handle:Owned }
impl Drop for Child {fn drop(&mut self) {unsafe {TerminateProcess(self.handle.0,1);}}}
struct Descriptor(windows_sys::Win32::Security::PSECURITY_DESCRIPTOR);
impl Descriptor {
    fn new(sddl:&str)->Result<Self,NativeError> {
        let mut descriptor=std::ptr::null_mut();
        if unsafe {ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(Path::new(sddl)).as_ptr(),1,
            &mut descriptor,std::ptr::null_mut())}==0 {return Err(fail());}
        Ok(Self(descriptor))
    }
    fn attributes(&self)->SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {nLength:size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor:self.0,bInheritHandle:0}
    }
}
impl Drop for Descriptor {fn drop(&mut self) {unsafe {LocalFree(self.0);}}}
struct Attributes {bytes:Vec<usize>,policy:Box<u64>,initialized:bool}
impl Attributes {
    fn new()->Result<Self,NativeError> {
        let mut size=0;
        unsafe {InitializeProcThreadAttributeList(std::ptr::null_mut(),1,0,&mut size);}
        if size==0 || size>65_536 {return Err(fail());}
        // Extension point disable + Microsoft-only DLLs, set before any user
        // code runs. Process ACLs alone do not block same-desktop hook DLLs.
        let mut result=Self {bytes:vec![0;size.div_ceil(size_of::<usize>())],
            policy:Box::new((1_u64<<32)|(1_u64<<44)),initialized:false};
        let list=result.bytes.as_mut_ptr().cast();
        if unsafe {InitializeProcThreadAttributeList(list,1,0,&mut size)}==0 {return Err(fail());}
        result.initialized=true;
        if unsafe {UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY as usize,
            (&mut *result.policy as *mut u64).cast(),size_of::<u64>(),std::ptr::null_mut(),std::ptr::null_mut())}==0 {
            return Err(fail());
        }Ok(result)
    }
}
impl Drop for Attributes {fn drop(&mut self) {if self.initialized {
    unsafe {DeleteProcThreadAttributeList(self.bytes.as_mut_ptr().cast());}
}}}
fn verify_mitigations(handle:windows_sys::Win32::Foundation::HANDLE)->Result<(),NativeError> {
    for policy in [ProcessSignaturePolicy,ProcessExtensionPointDisablePolicy] {
        let mut flags=0_u32;
        if unsafe {GetProcessMitigationPolicy(handle,policy,(&mut flags as *mut u32).cast(),size_of::<u32>())}==0
            || flags&1==0 {return Err(fail());}
    }Ok(())
}
fn verify_protected_object(handle:windows_sys::Win32::Foundation::HANDLE,limited:u32)->Result<(),NativeError> {
    use windows_sys::Win32::Security::{Authorization::{GetSecurityInfo,SE_KERNEL_OBJECT},
        ACL,ACCESS_ALLOWED_ACE,GetAce,GetSecurityDescriptorControl,SE_DACL_PROTECTED,
        OWNER_SECURITY_INFORMATION,DACL_SECURITY_INFORMATION};
    let mut owner=std::ptr::null_mut();let mut acl:*mut ACL=std::ptr::null_mut();let mut descriptor=std::ptr::null_mut();
    if unsafe {GetSecurityInfo(handle,SE_KERNEL_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,
        &mut owner,std::ptr::null_mut(),&mut acl,std::ptr::null_mut(),&mut descriptor)}!=0 {return Err(fail());}
    let _descriptor=Descriptor(descriptor);
    if nessie_windows_common::sid_to_string(owner).as_deref()!=Some("S-1-5-18") || acl.is_null() {return Err(fail());}
    let mut control=0;let mut revision=0;
    if unsafe {GetSecurityDescriptorControl(descriptor,&mut control,&mut revision)}==0
        || control&SE_DACL_PROTECTED==0 || unsafe {(*acl).AceCount}>32 {return Err(fail());}
    for index in 0..unsafe {(*acl).AceCount} as u32 {
        let mut pointer=std::ptr::null_mut();
        if unsafe {GetAce(acl,index,&mut pointer)}==0 || pointer.is_null() {return Err(fail());}
        let ace=unsafe {&*pointer.cast::<ACCESS_ALLOWED_ACE>()};
        if ace.Header.AceType!=0 {return Err(fail());}
        let sid=nessie_windows_common::sid_to_string((&ace.SidStart as *const u32).cast_mut().cast()).ok_or_else(fail)?;
        if sid!="S-1-5-18" && !(sid=="S-1-5-11" && ace.Mask&!limited==0) {return Err(fail());}
    }Ok(())
}
pub fn launch(release:&Release,tray:&Process,nonce:&str)->Result<Child,NativeError> {
    if !super::consent_contract::hex_id(nonce) || !tray.alive() {return Err(fail());}
    nessie_windows_common::process::interactive(tray).map_err(|_|fail())?;
    let mut token=std::ptr::null_mut();
    if unsafe {WTSQueryUserToken(tray.session,&mut token)}==0 {return Err(fail());}
    let session_token=Owned(token);
    // WTS must still identify this exact source owner, not a newly logged-in user.
    if nessie_windows_common::process::session_owner(tray.session).map_err(|_|fail())?!=tray.sid {return Err(fail());}
    let windows=nessie_windows_common::update_admission::known_folder(
        &windows_sys::Win32::UI::Shell::FOLDERID_Windows).map_err(|_|fail())?;
    // SYSTEM owns both objects. AU gets query/synchronize only. In particular,
    // no VM_WRITE, CREATE_THREAD, DUP_HANDLE, SET_INFORMATION, WRITE_DAC or OWNER.
    let process_security=Descriptor::new("O:SYG:SYD:P(A;;GA;;;SY)(A;;0x00101000;;;AU)")?;
    let thread_security=Descriptor::new("O:SYG:SYD:P(A;;GA;;;SY)(A;;0x00100800;;;AU)")?;
    // Protect the token object as well: QUERY only for the source owner, with
    // no DUPLICATE/ADJUST_DEFAULT route to undo new-thread protection.
    let token=ceremony_token(&session_token)?;
    let executable=&release.runtime.native_helper;
    let image=wide(executable);
    let mut arguments=wide(Path::new(&format!("\"{}\" t3-retained-approve {nonce}",executable.display())));
    let mut desktop=wide(Path::new("winsta0\\default"));
    let mut environment=wide(Path::new(&format!("SystemRoot={}",windows.display())));environment.push(0);
    let directory=wide(&release.runtime.root);
    let mut attributes=Attributes::new()?;
    let mut startup:STARTUPINFOEXW=unsafe {std::mem::zeroed()};startup.StartupInfo.cb=size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.lpDesktop=desktop.as_mut_ptr();startup.lpAttributeList=attributes.bytes.as_mut_ptr().cast();
    let mut created:PROCESS_INFORMATION=unsafe {std::mem::zeroed()};
    let started=unsafe {CreateProcessAsUserW(token.0,image.as_ptr(),arguments.as_mut_ptr(),
        &process_security.attributes(),&thread_security.attributes(),
        0,CREATE_UNICODE_ENVIRONMENT|CREATE_SUSPENDED|EXTENDED_STARTUPINFO_PRESENT|0x0800_0000,environment.as_mut_ptr().cast(),
        directory.as_ptr(),(&startup as *const STARTUPINFOEXW).cast::<STARTUPINFOW>(),&mut created)};
    if started==0 {return Err(fail());}
    let handle=Owned(created.hProcess);let thread=Owned(created.hThread);
    let result=(|| {
        verify_protected_object(handle.0,0x00101000)?;
        verify_protected_object(thread.0,0x00100800)?;
        verify_mitigations(handle.0)?;
        let mut actual_token=std::ptr::null_mut();
        if unsafe {windows_sys::Win32::System::Threading::OpenProcessToken(handle.0,0x00020008,&mut actual_token)}==0 {
            return Err(fail());
        }
        let actual_token=Owned(actual_token);verify_protected_object(actual_token.0,0x00020008)?;
        verify_default_dacl(actual_token.0)?;
        let process=Process::open(created.dwProcessId).map_err(|_|fail())?;
        if process.sid!=tray.sid || process.session!=tray.session || process.elevated
            || process.image!=*executable || !tray.alive() {return Err(fail());}
        process.signed(PIN).map_err(|_|fail())?;
        if unsafe {ResumeThread(thread.0)}==u32::MAX {return Err(fail());}Ok(process)
    })();
    match result {Ok(process)=>Ok(Child {process,handle}),Err(e)=>{unsafe {TerminateProcess(handle.0,1);}Err(e)}}
}

fn ceremony_token(session:&Owned)->Result<Owned,NativeError> {
    use windows_sys::Win32::Security::{DuplicateTokenEx,SecurityImpersonation,TokenPrimary,TOKEN_ALL_ACCESS,
        GetSecurityDescriptorDacl,SetTokenInformation,TokenDefaultDacl,TOKEN_DEFAULT_DACL};
    let security=Descriptor::new("O:SYG:SYD:P(A;;GA;;;SY)(A;;0x00020008;;;AU)")?;
    let mut token=std::ptr::null_mut();
    if unsafe {DuplicateTokenEx(session.0,TOKEN_ALL_ACCESS,&security.attributes(),SecurityImpersonation,
        TokenPrimary,&mut token)}==0 {return Err(fail());}
    let token=Owned(token);verify_protected_object(token.0,0x00020008)?;
    // New threads are user-owned by Windows. OWNER RIGHTS suppresses their
    // owner's implicit WRITE_DAC; AU may query/synchronize but cannot hijack.
    let defaults=Descriptor::new("D:P(A;;GA;;;SY)(A;;0x00100800;;;AU)(A;;RC;;;OW)")?;
    let mut present=0;let mut defaulted=0;let mut acl=std::ptr::null_mut();
    if unsafe {GetSecurityDescriptorDacl(defaults.0,&mut present,&mut acl,&mut defaulted)}==0
        || present==0 || acl.is_null() {return Err(fail());}
    let dacl=TOKEN_DEFAULT_DACL {DefaultDacl:acl};
    if unsafe {SetTokenInformation(token.0,TokenDefaultDacl,(&dacl as *const TOKEN_DEFAULT_DACL).cast(),
        size_of::<TOKEN_DEFAULT_DACL>() as u32)}==0 {return Err(fail());}
    verify_default_dacl(token.0)?;
    Ok(token)
}

fn verify_default_dacl(token:windows_sys::Win32::Foundation::HANDLE)->Result<(),NativeError> {
    use windows_sys::Win32::Security::{GetTokenInformation,TokenDefaultDacl,TOKEN_DEFAULT_DACL,GetAce,ACCESS_ALLOWED_ACE};
    let mut size=0;
    unsafe {GetTokenInformation(token,TokenDefaultDacl,std::ptr::null_mut(),0,&mut size);}
    if size==0 || size>65_536 {return Err(fail());}
    let mut bytes=vec![0_usize;(size as usize).div_ceil(size_of::<usize>())];
    if unsafe {GetTokenInformation(token,TokenDefaultDacl,bytes.as_mut_ptr().cast(),size,&mut size)}==0 {return Err(fail());}
    let acl=unsafe {(*bytes.as_ptr().cast::<TOKEN_DEFAULT_DACL>()).DefaultDacl};
    if acl.is_null() || unsafe {(*acl).AceCount}!=3 {return Err(fail());}
    let mut sids=std::collections::HashSet::new();
    for index in 0..3 {
        let mut pointer=std::ptr::null_mut();
        if unsafe {GetAce(acl,index,&mut pointer)}==0 || pointer.is_null() {return Err(fail());}
        let ace=unsafe {&*pointer.cast::<ACCESS_ALLOWED_ACE>()};
        if ace.Header.AceType!=0 || ace.Header.AceFlags!=0 {return Err(fail());}
        let sid=nessie_windows_common::sid_to_string((&ace.SidStart as *const u32).cast_mut().cast()).ok_or_else(fail)?;
        let expected=match sid.as_str() {"S-1-5-18"=>0x1000_0000,"S-1-5-11"=>0x00100800,"S-1-3-4"=>0x00020000,_=>return Err(fail())};
        if ace.Mask!=expected || !sids.insert(sid) {return Err(fail());}
    }Ok(())
}
