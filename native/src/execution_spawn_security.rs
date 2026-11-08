//! Security is installed on the primary token and process/thread objects by
//! SYSTEM at creation. The user child never receives WRITE_DAC or token mutation.
use nessie_windows_common::{custody::REJECTED,process::Owned};
use std::mem::size_of;
use windows_sys::Win32::{Foundation::{HANDLE,LocalFree},Security::{
    Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,SECURITY_ATTRIBUTES,
    DuplicateTokenEx,SecurityImpersonation,TokenPrimary,TOKEN_ALL_ACCESS,GetSecurityDescriptorDacl,
    SetTokenInformation,TokenDefaultDacl,TOKEN_DEFAULT_DACL},System::Threading::{
    InitializeProcThreadAttributeList,UpdateProcThreadAttribute,DeleteProcThreadAttributeList,
    PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_JOB_LIST,PROC_THREAD_ATTRIBUTE_PARENT_PROCESS}};
pub fn wide(value:&str)->Vec<u16>{value.encode_utf16().chain(Some(0)).collect()}
pub struct Security(pub windows_sys::Win32::Security::PSECURITY_DESCRIPTOR);
impl Security {
    pub fn new(sddl:&str)->Result<Self,String>{
        let mut ptr=std::ptr::null_mut();
        if unsafe{ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl).as_ptr(),1,&mut ptr,
            std::ptr::null_mut())}==0{return Err(REJECTED.into());}Ok(Self(ptr))
    }
    pub fn attributes(&self,inherit:bool)->SECURITY_ATTRIBUTES{
        SECURITY_ATTRIBUTES{nLength:size_of::<SECURITY_ATTRIBUTES>() as u32,lpSecurityDescriptor:self.0,
            bInheritHandle:i32::from(inherit)}
    }
}
impl Drop for Security{fn drop(&mut self){unsafe{LocalFree(self.0)};}}
pub fn token(session:&Owned,service:&str)->Result<Owned,String>{
    let security=Security::new(&format!("O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;{service})(A;;0x00020008;;;AU)"))?;
    let mut token=std::ptr::null_mut();
    if unsafe{DuplicateTokenEx(session.0,TOKEN_ALL_ACCESS,&security.attributes(false),SecurityImpersonation,
        TokenPrimary,&mut token)}==0{return Err(REJECTED.into());}
    let token=Owned(token);
    let defaults=Security::new(&format!("D:P(A;;GA;;;SY)(A;;GA;;;{service})(A;;0x00120800;;;AU)(A;;RC;;;OW)"))?;
    let mut present=0;let mut defaulted=0;let mut acl=std::ptr::null_mut();
    if unsafe{GetSecurityDescriptorDacl(defaults.0,&mut present,&mut acl,&mut defaulted)}==0||present==0||acl.is_null(){
        return Err(REJECTED.into());
    }
    let dacl=TOKEN_DEFAULT_DACL{DefaultDacl:acl};
    if unsafe{SetTokenInformation(token.0,TokenDefaultDacl,(&dacl as *const TOKEN_DEFAULT_DACL).cast(),
        size_of::<TOKEN_DEFAULT_DACL>() as u32)}==0{return Err(REJECTED.into());}Ok(token)
}
pub struct Attributes {
    pub bytes:Vec<usize>,policy:Box<u64>,handles:Vec<HANDLE>,jobs:Vec<HANDLE>,parent:Option<Box<HANDLE>>,initialized:bool,
}
impl Attributes {
    pub fn new(handles:Vec<HANDLE>,job:HANDLE,parent:Option<HANDLE>)->Result<Self,String>{
        let count=if parent.is_some(){4}else{3};let mut size=0;
        unsafe{InitializeProcThreadAttributeList(std::ptr::null_mut(),count,0,&mut size)};
        if size==0||size>65536{return Err(REJECTED.into());}
        let mut value=Self{bytes:vec![0;size.div_ceil(size_of::<usize>())],policy:Box::new((1u64<<32)|(1u64<<44)),
            handles,jobs:vec![job],parent:parent.map(Box::new),initialized:false};
        let list=value.bytes.as_mut_ptr().cast();
        if unsafe{InitializeProcThreadAttributeList(list,count,0,&mut size)}==0{return Err(REJECTED.into());}
        value.initialized=true;
        let mut set=|attribute:usize,data:*mut std::ffi::c_void,length:usize|->Result<(),String>{
            if unsafe{UpdateProcThreadAttribute(list,0,attribute,data,length,std::ptr::null_mut(),std::ptr::null_mut())}==0{
                return Err(REJECTED.into());}Ok(())
        };
        set(PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY as usize,(&mut *value.policy as *mut u64).cast(),size_of::<u64>())?;
        set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,value.handles.as_mut_ptr().cast(),value.handles.len()*size_of::<HANDLE>())?;
        set(PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,value.jobs.as_mut_ptr().cast(),size_of::<HANDLE>())?;
        if let Some(parent)=value.parent.as_mut(){
            set(PROC_THREAD_ATTRIBUTE_PARENT_PROCESS as usize,(&mut **parent as *mut HANDLE).cast(),size_of::<HANDLE>())?;
        }Ok(value)
    }
}
impl Drop for Attributes {fn drop(&mut self){if self.initialized{
    unsafe{DeleteProcThreadAttributeList(self.bytes.as_mut_ptr().cast())};
}}}
