//! Graph bootstrap carries an enrolled-directory reference, never the service's
//! machine key or a fabricated mapping to a user-profile source registration.
use nessie_windows_common::{custody::{RuntimeKind,REJECTED},custody_store::State,
    process::{self,Process},release::{Release,pin_service_private}};
use std::{io::Read,path::Path};
pub fn resolve(root:&Path,release:&Release,state:&State,requester:&Process,executor:&str)
    ->Result<(String,u32,String),String>{
    let directory=crate::paths::executor_state_dir(root,executor)?;
    let _root=pin_service_private(root,true)?;
    let _executors=pin_service_private(&crate::paths::executors_root(root),true)?;
    let _directory=pin_service_private(&directory,true)?;
    let mut owner=String::new();pin_service_private(&directory.join(crate::paths::PAIRED_BY_FILE),false)?
        .take(257).read_to_string(&mut owner).map_err(|_|REJECTED)?;
    let owner=owner.trim();
    if !nessie_windows_common::is_sid_string(owner){return Err(REJECTED.into());}
    crate::execution_admission::paired(root,executor,owner)?;
    if requester.image!=release.runtime.native_helper||!requester.alive(){return Err(REJECTED.into());}
    requester.signed(option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"))?;
    let parent=process::snapshot()?.into_iter().find(|p|p.pid==requester.generation.pid).ok_or(REJECTED)?.parent;
    let daemon=state.runtimes.values().find(|r|r.child.pid==parent&&r.release_digest==release.digest
        &&matches!(r.kind,RuntimeKind::ServiceDaemon|RuntimeKind::UserDaemon)).ok_or(REJECTED)?;
    let actual=Process::open(parent)?;
    if actual.generation!=daemon.child||!actual.alive()||actual.image!=release.runtime.node_executable
        ||!nessie_windows_common::custody_observation::job_members(&daemon.job_name)?.contains(&requester.generation.pid){
        return Err(REJECTED.into());
    }
    let session=if requester.session==0 {
        if requester.sid!=nessie_windows_common::service_channel::service_account_sid()?
            ||daemon.kind!=RuntimeKind::ServiceDaemon{return Err(REJECTED.into());}
        unsafe{windows_sys::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId()}
    }else{
        if requester.sid!=owner||daemon.kind!=RuntimeKind::UserDaemon{return Err(REJECTED.into());}
        process::interactive(requester)?;requester.session
    };
    if session==0||session==u32::MAX||process::session_owner(session)?!=owner{return Err(REJECTED.into());}
    Ok((owner.into(),session,directory.to_str().ok_or(REJECTED)?.into()))
}
