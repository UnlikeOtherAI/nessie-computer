use super::handles::fail;
use crate::protocol::NativeError;
use nessie_windows_common::{process::{Process, interactive, snapshot}, release::{Release, load}};
pub const PIN: Option<&str> = option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");

pub struct Context { pub release: Release, pub own: Process, parent: Option<Process> }
impl Context {
    pub fn open(require_broker: bool) -> Result<Self, NativeError> {
        if !cfg!(target_arch="x86_64") {return Err(fail());}
        crate::personal_state_context::require_release()?;
        let mut release = load(PIN).map_err(|_| fail())?;
        release.verify_launch_consumers(PIN).map_err(|_| fail())?;
        let own = Process::open(std::process::id()).map_err(|_| fail())?;
        interactive(&own).map_err(|_| fail())?;
        if own.image != release.runtime.native_helper { return Err(fail()); }
        let parent = if require_broker {
            let pid = snapshot().map_err(|_| fail())?.into_iter().find(|p| p.pid == own.generation.pid)
                .ok_or_else(fail)?.parent;
            let parent = Process::open(pid).map_err(|_| fail())?;
            if parent.image.file_name().and_then(|v|v.to_str())!=Some("nessie-computer-updater.exe")
                || parent.sid!="S-1-5-18" || parent.session!=0
                || parent.generation.started_at.parse::<u64>().map_err(|_|fail())?
                    >=own.generation.started_at.parse::<u64>().map_err(|_|fail())? {return Err(fail());}
            parent.signed(PIN).map_err(|_| fail())?;
            Some(parent)
        } else { None };
        let result = Self { release, own, parent }; result.recheck()?; Ok(result)
    }
    pub fn recheck(&self) -> Result<(), NativeError> {
        if !self.own.alive() || self.parent.as_ref().is_some_and(|p| !p.alive()) { return Err(fail()); }
        interactive(&self.own).map_err(|_| fail())
    }
    pub fn peer(&self, pid: u32) -> Result<Process, NativeError> {
        let peer = Process::open(pid).map_err(|_| fail())?;
        if peer.image != self.release.runtime.native_helper || peer.sid != self.own.sid
            || peer.session != self.own.session || !peer.alive() { return Err(fail()); }
        interactive(&peer).map_err(|_| fail())?;
        peer.signed(PIN).map_err(|_| fail())?;
        Ok(peer)
    }
}
