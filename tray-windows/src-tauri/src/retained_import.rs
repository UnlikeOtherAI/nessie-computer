//! Local, explicit review only. The backend's UOA enrollment action is separate.
use serde_json::{Value,json};
const ERROR:&str="retained_import_local_consent_unavailable";
struct NativeReview { value: Value, release: Option<Box<dyn FnOnce()>> }
impl Drop for NativeReview {
    fn drop(&mut self) {if let Some(release)=self.release.take() {release();}}
}
fn report(executor:&str,input:Value)->Result<Value,String> {
    if !crate::user_connections::owns(executor) {return Err(ERROR.into());}
    crate::user_runtime::run(&["t3-retained".into(),"--executor".into(),executor.into()],Some(&input))
}
#[tauri::command]
pub async fn executor_retained_status(executor_id:String)->Result<Value,String> {
    tauri::async_runtime::spawn_blocking(move || {
        let roots=report(&executor_id,json!({"operation":"roots"}))?;
        let pending=report(&executor_id,json!({"operation":"issuer.pending"}))?;
        let held = snapshot(&executor_id)?;
        let handoff = held.as_ref().and_then(|v|v["challenge"]["challengeId"].as_str())
            .and_then(|id|crate::user_connections::retained_status(&executor_id,id));
        Ok(json!({"roots":roots,"pending":pending,"active":held.is_some(),"handoff":handoff}))
    }).await.map_err(|_|ERROR.to_owned())?
}
#[tauri::command]
pub async fn executor_retained_action(executor_id:String,action:String,id:String)->Result<Value,String> {
    tauri::async_runtime::spawn_blocking(move || action_inner(&executor_id,&action,&id)).await.map_err(|_|ERROR.to_owned())?
}
#[tauri::command]
pub fn executor_retained_snapshot(executor_id:String)->Result<Value,String> {
    Ok(snapshot(&executor_id)?.unwrap_or(Value::Null))
}
fn action_inner(executor:&str,action:&str,id:&str)->Result<Value,String> {
    if !crate::user_connections::owns(executor) {return Err(ERROR.into());}
    let held = snapshot(executor)?;
    if action=="revoke" {
        if let Some(held) = held {
            let id = held["challenge"]["challengeId"].as_str().ok_or(ERROR)?;
            if !matches!(crate::user_connections::retained_status(executor,id).as_deref(),Some("closed"|"refused")) {
                crate::user_connections::retained_cancel(executor,id)?;
            }
        }
        stop(executor)?;return Ok(json!({"status":"revoked"}));
    }
    if held.is_some() {return Err("retained_import_active_handoff_requires_close".into());}
    let (kind,input)=if action=="offer" {
        let roots=report(executor,json!({"operation":"roots"}))?;
        if !roots.as_array().is_some_and(|v|v.iter().any(|r|r["admittedRootKey"]==id)) {return Err(ERROR.into());}
        ("offer",json!({"executorId":executor,"admittedRootKey":id}))
    } else {
        let pending=report(executor,json!({"operation":"issuer.pending"}))?;
        let (list,field,kind)=match action {"enroll"=>("enrollments","enrollmentId","enroll"),
            "approve"=>("imports","challengeId","approve"),_=>return Err(ERROR.into())};
        let input=pending[list].as_array().and_then(|v|v.iter().find(|r|r[field]==id)).ok_or(ERROR)?.clone();
        if input["executorId"]!=executor {return Err(ERROR.into());}
        if kind=="approve" && input["selection"]["kind"]!="whole_source" {
            return Err("retained_import_whole_source_required".into());
        }
        (kind,input)
    };
    if kind=="approve" {crate::user_connections::retained_ready(executor)?;}
    let review=start(executor,kind,input)?;
    let result=match kind {
        "offer"=>report(executor,json!({"operation":"issuer.offer","offer":&review.value})),
        "enroll"=>report(executor,json!({"operation":"issuer.proof","proof":&review.value})),
        // Only the actual held snapshot crosses the inherited pipe to this
        // tray's already-running managed daemon. It performs consent.commit.
        _=>crate::user_connections::retained_begin(executor,&snapshot(executor)?.ok_or(ERROR)?),
    };
    // An uncertain handoff retains the issuer pipe until a correlated completed
    // close/refusal or its original hard deadline. Never substitute process exit.
    result
}
#[cfg(windows)]
use windows::{start,stop,snapshot};
#[cfg(not(windows))]
fn start(_: &str,_:&str,_:Value)->Result<NativeReview,String> {Err(ERROR.into())}
#[cfg(not(windows))]
fn stop(_:&str)->Result<(),String> {Err(ERROR.into())}
#[cfg(not(windows))]
fn snapshot(_:&str)->Result<Option<Value>,String> {Err(ERROR.into())}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{fs::File,io::{Read,Write},os::windows::{io::{AsRawHandle,FromRawHandle},ffi::OsStrExt},
        collections::HashMap,sync::{Arc,Mutex,OnceLock,atomic::{AtomicBool,Ordering}},time::{Instant,Duration}};
    use windows_sys::Win32::{Foundation::INVALID_HANDLE_VALUE,Storage::FileSystem::{CreateFileW,OPEN_EXISTING},
        System::Pipes::PeekNamedPipe};
    struct Approval {pipe:File,cancelled:AtomicBool,deadline:Instant,result:Mutex<Option<Value>>}
    static ACTIVE:OnceLock<Mutex<HashMap<String,Arc<Approval>>>>=OnceLock::new();
    fn active()->&'static Mutex<HashMap<String,Arc<Approval>>> {ACTIVE.get_or_init(||Mutex::new(HashMap::new()))}
    pub fn stop(executor:&str)->Result<(),String> {
        if let Some(v)=active().lock().map_err(|_|ERROR)?.remove(executor) {v.cancelled.store(true,Ordering::Release);}
        Ok(())
    }
    pub fn snapshot(executor:&str)->Result<Option<Value>,String> {
        let mut entries=active().lock().map_err(|_|ERROR)?;
        entries.retain(|_,v|v.deadline>Instant::now() && !v.cancelled.load(Ordering::Acquire));
        entries.get(executor).map(|v|v.result.lock().map(|r|r.clone()).map_err(|_|ERROR.to_owned())).unwrap_or(Ok(None))
    }
    fn retire(executor:&str,approval:&Arc<Approval>) {
        if let Ok(mut entries)=active().lock() {
            if entries.get(executor).is_some_and(|v|Arc::ptr_eq(v,approval)) {entries.remove(executor);}
        }
    }
    pub(super) fn start(executor:&str,kind:&str,input:Value)->Result<NativeReview,String> {
        let mut entries=active().lock().map_err(|_|ERROR)?;
        entries.retain(|_,v|v.deadline>Instant::now() && !v.cancelled.load(Ordering::Acquire));
        if entries.contains_key(executor) {return Err("retained_import_local_review_already_active".into());}
        nessie_windows_provenance::require_release_signature(option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"))?;
        let name:Vec<u16>=std::ffi::OsStr::new(r"\\.\pipe\NessieT3SourceIssuer").encode_wide().chain(Some(0)).collect();
        let handle=unsafe {CreateFileW(name.as_ptr(),nessie_windows_common::CONTROL_PIPE_CLIENT_ACCESS,0,
            std::ptr::null(),OPEN_EXISTING,0x0010_0000|0x0001_0000,std::ptr::null_mut())};
        if handle==INVALID_HANDLE_VALUE {return Err(ERROR.into());}
        let mut pipe=unsafe {File::from_raw_handle(handle)};
        nessie_windows_common::service_channel::verify_updater(handle,option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"))?;
        let bytes=serde_json::to_vec(&json!({"kind":kind,"input":input})).map_err(|_|ERROR)?;
        if bytes.len()>65_536 {return Err(ERROR.into());}
        let mut frame=(bytes.len() as u32).to_le_bytes().to_vec();frame.extend(bytes);
        pipe.write_all(&frame).map_err(|_|ERROR)?;
        let approval=Arc::new(Approval {pipe:pipe.try_clone().map_err(|_|ERROR)?,cancelled:AtomicBool::new(false),
            deadline:Instant::now()+Duration::from_secs(300),result:Mutex::new(None)});
        entries.insert(executor.to_owned(),approval.clone());
        drop(entries);
        let result=(|| {
            let mut size=None;
            while Instant::now()<approval.deadline && !approval.cancelled.load(Ordering::Acquire) {
                let mut available=0;
                if unsafe {PeekNamedPipe(handle,std::ptr::null_mut(),0,std::ptr::null_mut(),&mut available,std::ptr::null_mut())}==0 {
                    return Err(ERROR.to_owned());
                }
                if size.is_none() && available>=4 {
                    let mut bytes=[0;4];pipe.read_exact(&mut bytes).map_err(|_|ERROR)?;
                    let length=u32::from_le_bytes(bytes) as usize;if length==0 || length>65_536 {return Err(ERROR.into());}
                    size=Some(length);available-=4;
                }
                if let Some(size)=size.filter(|s|available as usize>=*s) {
                    let mut bytes=vec![0;size];pipe.read_exact(&mut bytes).map_err(|_|ERROR)?;
                    let response:Value=serde_json::from_slice(&bytes).map_err(|_|ERROR)?;
                    if response["ok"]!=true {return Err(ERROR.into());}return Ok(response["value"].clone());
                }
                std::thread::sleep(Duration::from_millis(25));
            }Err(ERROR.into())
        })();
        if let Ok(receipt)=&result {
            if kind=="approve" {
                *approval.result.lock().map_err(|_|ERROR)?=Some(json!({"challenge":input,"receipt":receipt,
                    "expiresAtMs":input["grantExpiresAtMs"]}));
                let executor=executor.to_owned();let held=Arc::downgrade(&approval);
                let challenge_id=input["challengeId"].as_str().ok_or(ERROR)?.to_owned();
                std::thread::spawn(move || {
                    while let Some(v)=held.upgrade() {
                        let live=unsafe {PeekNamedPipe(v.pipe.as_raw_handle(),std::ptr::null_mut(),0,std::ptr::null_mut(),
                            std::ptr::null_mut(),std::ptr::null_mut())}!=0;
                        let drained=matches!(crate::user_connections::retained_status(&executor,&challenge_id).as_deref(),
                            Some("closed"|"refused"));
                        if Instant::now()>=v.deadline || v.cancelled.load(Ordering::Acquire) || !live || drained {break;}
                        drop(v);std::thread::sleep(Duration::from_millis(100));
                    }
                    if let Ok(mut entries)=active().lock() {
                        if entries.get(&executor).is_some_and(|v|held.ptr_eq(&Arc::downgrade(v))) {entries.remove(&executor);}
                    }
                });
            }
        }
        match result {
            Ok(value)=> {
                // Offer/enrollment proof lifetime includes the server submission.
                // Cleanup owns this exact ceremony, not a successor after revoke.
                let release:Option<Box<dyn FnOnce()>>=if kind!="approve" {
                    let executor=executor.to_owned();
                    Some(Box::new(move || retire(&executor,&approval)))
                } else {None};
                Ok(NativeReview {value,release})
            },
            Err(error)=> {retire(executor,&approval);Err(error)},
        }
    }
}
