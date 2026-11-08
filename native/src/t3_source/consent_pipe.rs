//! This channel has no approval operation. Kernel-authenticated native peers can
//! only consume/recheck/revoke a receipt already issued after local affirmation.
use super::{consent_peer::Context, consent_state::Consent, handles::{fail,wide}, resource::Resource,issuer_client::Issuer};
use crate::protocol::NativeError;
use serde_json::{json,Value};
use std::{fs::File,io::{Read,Write},os::windows::io::{FromRawHandle,AsRawHandle},path::Path,
    sync::{Arc,atomic::{AtomicBool,Ordering}},time::Duration};
use windows_sys::Win32::{Foundation::{GetLastError,LocalFree,INVALID_HANDLE_VALUE,ERROR_PIPE_CONNECTED},
    Security::SECURITY_ATTRIBUTES, Storage::FileSystem::{CreateFileW,FILE_FLAG_FIRST_PIPE_INSTANCE,PIPE_ACCESS_DUPLEX,OPEN_EXISTING},
    System::Pipes::{ConnectNamedPipe,CreateNamedPipeW,DisconnectNamedPipe,GetNamedPipeClientProcessId,
        GetNamedPipeServerProcessId,PeekNamedPipe,PIPE_NOWAIT,PIPE_REJECT_REMOTE_CLIENTS}};
const MAX: usize = 65_536;

fn pipe_name(instance: &str) -> Result<String,NativeError> {
    if instance.len()!=64 || !instance.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err(fail()); }
    Ok(format!(r"\\.\pipe\nessie-t3-consent-{instance}"))
}
fn write(file: &mut File,value: &Value) -> Result<(),NativeError> {
    let bytes=serde_json::to_vec(value).map_err(|_|fail())?;
    if bytes.len()>4096 {return Err(fail());}
    file.write_all(&(bytes.len() as u32).to_le_bytes()).and_then(|()|file.write_all(&bytes)).map_err(|_|fail())
}
fn frame(file:&mut File) -> Result<Value,NativeError> {
    let mut length=[0;4];file.read_exact(&mut length).map_err(|_|fail())?;
    let length=u32::from_le_bytes(length) as usize;
    if length==0 || length>MAX {return Err(fail());}
    let mut bytes=vec![0;length];file.read_exact(&mut bytes).map_err(|_|fail())?;
    serde_json::from_slice(&bytes).map_err(|_|fail())
}
pub fn serve(context:&Context,resource:Resource,mut consent:Consent,revoked:Arc<AtomicBool>,issuer:Arc<Issuer>) -> Result<(),NativeError> {
    let name=pipe_name(consent.receipt["issuerInstance"].as_str().ok_or_else(fail)?)?;
    let descriptor=crate::state_security::private_pipe_descriptor()?;
    let attributes=SECURITY_ATTRIBUTES {nLength:std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor:descriptor,bInheritHandle:0};
    let handle=unsafe {CreateNamedPipeW(wide(Path::new(&name)).as_ptr(),PIPE_ACCESS_DUPLEX|FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_NOWAIT|PIPE_REJECT_REMOTE_CLIENTS,1,65_536,65_536,0,&attributes)};
    unsafe {LocalFree(descriptor);}
    if handle==INVALID_HANDLE_VALUE {return Err(fail());}
    let mut pipe=unsafe {File::from_raw_handle(handle)};
    // Only an issued receipt is sent to the local native management parent.
    consent.challenge.bind(&resource)?;context.recheck()?;issuer.recheck()?;
    issuer.ready(&consent.receipt)?;
    let mut connected=false;
    let mut peer=None;
    let mut request_size=None;
    loop {
        context.recheck()?;consent.recheck()?;consent.challenge.bind(&resource)?;resource.renew()?;
        if revoked.load(Ordering::Acquire) {return Err(fail());}
        if !connected {
            let answer=unsafe {ConnectNamedPipe(handle,std::ptr::null_mut())};
            // In NOWAIT mode a nonzero first result only makes the instance
            // available. Only PIPE_CONNECTED proves an actual client.
            if answer==0 && unsafe {GetLastError()}==ERROR_PIPE_CONNECTED {
                let mut pid=0;
                if unsafe {GetNamedPipeClientProcessId(handle,&mut pid)}==0 {return Err(fail());}
                peer=Some(context.peer(pid)?);connected=true;
            }
        }
        if connected {
            let mut available=0;
            if !peer.as_ref().is_some_and(|p|p.alive()) || unsafe {PeekNamedPipe(handle,std::ptr::null_mut(),0,
                std::ptr::null_mut(),&mut available,std::ptr::null_mut())}==0 {
                unsafe {DisconnectNamedPipe(handle);} connected=false;peer=None;request_size=None;
            } else {
                if request_size.is_none() && available>=4 {
                    let mut bytes=[0;4];pipe.read_exact(&mut bytes).map_err(|_|fail())?;
                    let size=u32::from_le_bytes(bytes) as usize;
                    if size==0 || size>MAX {return Err(fail());}
                    request_size=Some(size);available-=4;
                }
                if let Some(size)=request_size.filter(|size|available as usize>=*size) {
                    let mut bytes=vec![0;size];pipe.read_exact(&mut bytes).map_err(|_|fail())?;
                    let request:Value=serde_json::from_slice(&bytes).map_err(|_|fail())?;
                    let result=consent.dispatch(&request);
                    consent.challenge.bind(&resource)?;context.recheck()?;
                    if revoked.load(Ordering::Acquire) {return Err(fail());}
                    let response=match result {Ok(value)=>json!({"ok":true,"value":value}),
                        Err(_)=>json!({"ok":false})};
                    write(&mut pipe,&response)?;
                    // The client reads the response then closes; retain the
                    // instance until that EOF so Disconnect cannot discard it.
                    while peer.as_ref().is_some_and(|p|p.alive()) {
                        consent.challenge.bind(&resource)?;context.recheck()?;resource.renew()?;consent.transport_live()?;
                        if revoked.load(Ordering::Acquire) {return Err(fail());}
                        let mut available=0;
                        if unsafe {PeekNamedPipe(handle,std::ptr::null_mut(),0,std::ptr::null_mut(),
                            &mut available,std::ptr::null_mut())}==0 {break;}
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    unsafe {DisconnectNamedPipe(handle);} connected=false;peer=None;request_size=None;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
pub fn verify(context:&Context,request:&Value) -> Result<Value,NativeError> {
    let name=pipe_name(request["receipt"]["issuerInstance"].as_str().ok_or_else(fail)?)?;
    let handle=unsafe {CreateFileW(wide(Path::new(&name)).as_ptr(),0x8000_0000|0x4000_0000,0,
        std::ptr::null(),OPEN_EXISTING,0x0010_0000|0x0001_0000,std::ptr::null_mut())};
    if handle==INVALID_HANDLE_VALUE {return Err(fail());}
    let mut pipe=unsafe {File::from_raw_handle(handle)};
    let mut pid=0;
    if unsafe {GetNamedPipeServerProcessId(pipe.as_raw_handle(),&mut pid)}==0 {return Err(fail());}
    let peer=context.peer(pid)?;
    let bytes=serde_json::to_vec(request).map_err(|_|fail())?;
    if bytes.len()>MAX {return Err(fail());}
    pipe.write_all(&(bytes.len() as u32).to_le_bytes()).and_then(|()|pipe.write_all(&bytes)).map_err(|_|fail())?;
    let response=frame(&mut pipe)?;
    if !peer.alive() || response["ok"]!=true {return Err(fail());}
    context.recheck()?;
    Ok(response["value"].clone())
}
