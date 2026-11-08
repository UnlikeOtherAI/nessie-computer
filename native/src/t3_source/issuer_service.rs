//! Narrow listener inside the existing authenticated SYSTEM updater process.
//! No signing key or generic signing operation is exposed to the daemon/tray.
use super::{handles::fail,issuer_wire::{self,Reader},issuer_launch,issuer_signing::SigningSession,consent_peer::PIN};
use crate::protocol::NativeError;
use nessie_windows_common::{process::{Process,interactive},release::{self,Release}};
use serde_json::json;
use std::{fs::File,os::windows::io::AsRawHandle,sync::{Arc,Mutex,atomic::{AtomicBool,AtomicUsize,Ordering}},
    time::{Instant,Duration}};
use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;

fn installed()->Result<Release,NativeError> {
    if !cfg!(target_arch="x86_64") {return Err(fail());}
    let own=Process::open(std::process::id()).map_err(|_|fail())?;
    if own.sid!="S-1-5-18" || own.session!=0 {return Err(fail());}
    let program=nessie_windows_common::update_admission::known_folder(
        &windows_sys::Win32::UI::Shell::FOLDERID_ProgramFiles).map_err(|_|fail())?;
    let mut r=release::load_at(&program.join("Nessie Executor/nessie-executor-native.exe"),PIN).map_err(|_|fail())?;
    r.verify_launch_consumers(PIN).map_err(|_|fail())?;Ok(r)
}
fn client(file:&File)->Result<Process,NativeError> {
    let mut pid=0;
    if unsafe {GetNamedPipeClientProcessId(file.as_raw_handle(),&mut pid)}==0 {return Err(fail());}
    Process::open(pid).map_err(|_|fail())
}
pub fn serve(stopped:Arc<AtomicBool>)->Result<(),NativeError> {
    let _=installed()?;
    let active=Arc::new(AtomicUsize::new(0));let key_lock=Arc::new(Mutex::new(()));
    let mut pending=issuer_wire::instance(issuer_wire::PIPE,true,None)?;
    while !stopped.load(Ordering::Acquire) {
        match issuer_wire::connect(&pending) {
            Ok(false)=>{std::thread::sleep(Duration::from_millis(25));continue;},
            Err(_)=>{pending=issuer_wire::instance(issuer_wire::PIPE,false,None)?;continue;},
            Ok(true)=>{},
        }
        // Keep an instance alive across handoff; another process cannot occupy the name.
        let next=issuer_wire::instance(issuer_wire::PIPE,false,None)?;
        let file=std::mem::replace(&mut pending,next);
        if active.load(Ordering::Acquire)>=4 {continue;}
        active.fetch_add(1,Ordering::AcqRel);
        let active=active.clone();let stopped=stopped.clone();let key_lock=key_lock.clone();
        std::thread::spawn(move || {let _=connection(file,stopped,key_lock);active.fetch_sub(1,Ordering::AcqRel);});
    }Ok(())
}
fn connection(mut file:File,stopped:Arc<AtomicBool>,key_lock:Arc<Mutex<()>>)->Result<(),NativeError> {
    let release=installed()?;let tray=client(&file)?;
    if tray.image!=release.runtime.root.join("nessie-executor-tray.exe") {return Err(fail());}
    interactive(&tray).map_err(|_|fail())?;tray.signed(PIN).map_err(|_|fail())?;
    let request=Reader::new().read(&mut file,Instant::now()+Duration::from_secs(5))?;
    if request.as_object().is_none_or(|o|o.len()!=2) {return Err(fail());}
    let kind=request["kind"].as_str().ok_or_else(fail)?.to_owned();
    let mut signing=SigningSession::new(kind,request["input"].clone())?;
    let nonce=super::consent_state::random_id()?;
    let mut pipe=issuer_wire::instance(&format!(r"\\.\pipe\NessieT3Ceremony-{nonce}"),true,Some(&tray.sid))?;
    let child=issuer_launch::launch(&release,&tray,&nonce)?;
    let deadline=Instant::now()+Duration::from_secs(300);
    let connected_deadline=Instant::now()+Duration::from_secs(5);
    while !issuer_wire::connect(&pipe)? {
        if Instant::now()>=connected_deadline || !child.process.alive() || !tray.alive()
            || stopped.load(Ordering::Acquire) || !issuer_wire::alive(&file) {return Err(fail());}
        std::thread::sleep(Duration::from_millis(10));
    }
    if client(&pipe)?.generation!=child.process.generation {return Err(fail());}
    issuer_wire::write(&mut pipe,&request)?;
    let mut reader=Reader::new();let mut ready=false;
    while Instant::now()<deadline && !stopped.load(Ordering::Acquire) && tray.alive() && child.process.alive()
        && issuer_wire::alive(&file) {
        interactive(&tray).map_err(|_|fail())?;
        if let Some(message)=reader.poll(&mut pipe)? {
            if message.as_object().is_none_or(|o|o.len()!=2) {return Err(fail());}
            let op=message["operation"].as_str().ok_or_else(fail)?;
            if op=="ready" {
                if ready {return Err(fail());}ready=true;
                issuer_wire::write(&mut file,&json!({"ok":true,"value":message["payload"]}))?;
            } else {
                // Serializes create/read of one durable key without copying it to user space.
                let _guard=key_lock.lock().map_err(|_|fail())?;
                let result=signing.dispatch(&tray.sid,op,message["payload"].clone())?;
                issuer_wire::write(&mut pipe,&json!({"ok":true,"value":result}))?;
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // Drop kills our child, closing held source/receipt and all signing access.
    Ok(())
}
