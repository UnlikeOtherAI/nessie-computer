//! Service-only launch home resolution. No paths or keys are serialized.
use super::{resources, DescriptorContext, Held};
use nessie_windows_common::{custody::REJECTED, execution::{Custody, Graph},
    execution_resource_handles::HeldCandidateDirectory, process::{Owned, Process}};
use std::{path::{Path, PathBuf}, marker::PhantomData, rc::Rc};

#[derive(Clone)]
struct Resolution { resource_id: String, graph: Graph, custody: Custody, paired_origin: String }
#[derive(Clone)]
pub(crate) struct ResolvedLaunchHome {
    canonical_path: PathBuf, identity: String, owner_sid: String, role: &'static str, proof: Resolution,
}
impl ResolvedLaunchHome {
    pub(crate) fn canonical_path(&self) -> &Path { &self.canonical_path }
    pub(crate) fn identity(&self) -> &str { &self.identity }
    fn recheck(&self, graph: &Process) -> Result<(), String> {
        if graph.generation != self.proof.custody.runtime || graph.sid != self.owner_sid { return Err(REJECTED.into()); }
        let context = DescriptorContext { custody: self.proof.custody.clone(), paired_origin: self.proof.paired_origin.clone() };
        let current = resolve_launch_homes(&self.proof.resource_id, graph, &context, &self.proof.graph)?;
        let home = match self.role { "continuation" => current.continuation, "history" => current.history,
            "credential" => current.credential, _ => return Err(REJECTED.into()) };
        if home.identity != self.identity || home.canonical_path != self.canonical_path { return Err(REJECTED.into()); }
        Ok(())
    }
}
pub(crate) struct ResolvedLaunchHomes {
    pub continuation: ResolvedLaunchHome,
    pub history: ResolvedLaunchHome,
    pub credential: ResolvedLaunchHome,
}

fn resolve_role(held: &Held, proof: &Resolution, role: &'static str, reference: &str) -> Result<ResolvedLaunchHome, String> {
    let b = &proof.graph.binding;
    let mut refs = held.receipt.evidence.provider_references.iter().filter(|r| r.reference_id == reference
        && r.role == role && r.instance_id == b.provider_instance_id && r.driver == b.driver);
    let reference = refs.next().ok_or(REJECTED)?;
    if refs.next().is_some() { return Err(REJECTED.into()); }
    let mut objects = held.objects.iter().filter(|o| o.description.kind == "provider-home"
        && o.description.private && o.description.identity == reference.identity);
    let canonical_path = objects.next().ok_or(REJECTED)?.directory_path(&held.caller.sid)?;
    // Multiple configured aliases may duplicate the same object. Every such
    // handle must still name that one kernel-resolved directory.
    for object in objects {
        if object.directory_path(&held.caller.sid)? != canonical_path { return Err(REJECTED.into()); }
    }
    Ok(ResolvedLaunchHome { canonical_path, identity: reference.identity.clone(),
        owner_sid: held.caller.sid.clone(), role, proof: proof.clone() })
}

/// Requires an already accepted exact Graph, not merely matching Binding fields.
/// Caller/context are produced by execution_context's protected native peer gate.
pub(crate) fn resolve_launch_homes(resource_id: &str, caller: &Process, context: &DescriptorContext,
    graph: &Graph) -> Result<ResolvedLaunchHomes, String> {
    let mut resources = resources().lock().map_err(|_| REJECTED)?;
    let result = (|| {
        let held = resources.get(resource_id).ok_or(REJECTED)?;
        held.recheck()?;
        held.check_binding(caller, context, &graph.binding)?;
        let digest = nessie_windows_common::execution::value_digest(&serde_json::to_value(graph).map_err(|_| REJECTED)?)?;
        if held.inspections.get(&graph.nonce) != Some(&digest) || held.graph_generation.is_none() { return Err(REJECTED.into()); }
        let proof = Resolution { resource_id: resource_id.into(), graph: graph.clone(), custody: context.custody.clone(),
            paired_origin: context.paired_origin.clone() };
        let homes = ResolvedLaunchHomes {
            continuation: resolve_role(held, &proof, "continuation", &graph.binding.continuation_home_key)?,
            history: resolve_role(held, &proof, "history", &graph.binding.history_home_key)?,
            credential: resolve_role(held, &proof, "credential", &graph.binding.credential_binding_id)?,
        };
        held.recheck()?;
        Ok(homes)
    })();
    if result.is_err() { resources.remove(resource_id); }
    result
}

/// Keeps candidate namespace pins through preparation/creation/use. Contains no
/// credentials, token handle or serializable authority; source loss still refuses.
pub(crate) struct HeldLaunchHome { candidate: HeldCandidateDirectory, graph: Process, resolved: ResolvedLaunchHome }
impl HeldLaunchHome {
    /// Actual provider payload must use this volume GUID spelling after matching;
    /// retaining a drive-letter alias would leave its DOS-device map unpinned.
    pub(crate) fn canonical_path(&self) -> Result<PathBuf, String> {
        self.recheck()?;
        Ok(self.resolved.canonical_path.clone())
    }
    pub(crate) fn recheck(&self) -> Result<(), String> {
        self.resolved.recheck(&self.graph)?;
        self.candidate.recheck()?;
        if self.candidate.identity() != self.resolved.identity
            || self.candidate.canonical_path()? != self.resolved.canonical_path { return Err(REJECTED.into()); }
        self.resolved.recheck(&self.graph)
    }
}
pub(crate) fn match_launch_home(actual_graph: &Process, candidate: &Path,
    resolved: &ResolvedLaunchHome) -> Result<HeldLaunchHome, String> {
    resolved.recheck(actual_graph)?;
    let graph = Process::open(actual_graph.generation.pid)?;
    if graph.generation != actual_graph.generation || graph.sid != resolved.owner_sid { return Err(REJECTED.into()); }
    let impersonation = OwnerImpersonation::enter(&graph)?;
    let candidate = HeldCandidateDirectory::open(candidate, &resolved.owner_sid);
    impersonation.finish(); // Restore service identity before resource/service state access.
    let candidate = candidate?;
    let held = HeldLaunchHome { candidate, graph, resolved: resolved.clone() };
    held.recheck()?;
    Ok(held)
}

/// Scoped to this service thread; cannot be sent across an await/thread boundary.
/// Failure to restore service identity terminates rather than continuing under
/// another principal. Never modifies a process/token ACL or enables a privilege.
struct OwnerImpersonation { active: bool, _not_send: PhantomData<Rc<()>> }
impl OwnerImpersonation {
    fn enter(graph: &Process) -> Result<Self, String> {
        use windows_sys::Win32::{Foundation::{GetLastError, ERROR_NO_TOKEN},
            Security::{DuplicateTokenEx, SecurityImpersonation, TokenImpersonation, TOKEN_DUPLICATE,
                TOKEN_QUERY, TOKEN_IMPERSONATE, ImpersonateLoggedOnUser, GetTokenInformation, TokenUser, TOKEN_USER},
            System::Threading::{GetCurrentThread, OpenThreadToken, OpenProcessToken}};
        let mut existing = std::ptr::null_mut();
        if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut existing) } != 0 {
            drop(Owned(existing)); return Err(REJECTED.into());
        }
        if unsafe { GetLastError() } != ERROR_NO_TOKEN || !graph.alive() { return Err(REJECTED.into()); }
        let mut primary = std::ptr::null_mut();
        if unsafe { OpenProcessToken(graph.handle.0, TOKEN_DUPLICATE | TOKEN_QUERY, &mut primary) } == 0 { return Err(REJECTED.into()); }
        let primary = Owned(primary);
        let mut token = std::ptr::null_mut();
        if unsafe { DuplicateTokenEx(primary.0, TOKEN_QUERY | TOKEN_IMPERSONATE, std::ptr::null(),
            SecurityImpersonation, TokenImpersonation, &mut token) } == 0 { return Err(REJECTED.into()); }
        let token = Owned(token);
        let mut size = 0;
        unsafe { GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut size); }
        if size == 0 || size > 65536 { return Err(REJECTED.into()); }
        let mut bytes = vec![0u8; size as usize];
        if unsafe { GetTokenInformation(token.0, TokenUser, bytes.as_mut_ptr().cast(), size, &mut size) } == 0
            || nessie_windows_common::sid_to_string(unsafe { (*bytes.as_ptr().cast::<TOKEN_USER>()).User.Sid }).as_deref()
                != Some(graph.sid.as_str()) || !graph.alive() { return Err(REJECTED.into()); }
        if unsafe { ImpersonateLoggedOnUser(token.0) } == 0 { return Err(REJECTED.into()); }
        Ok(Self { active: true, _not_send: PhantomData })
    }
    fn finish(mut self) { self.restore(); }
    fn restore(&mut self) {
        if self.active {
            if unsafe { windows_sys::Win32::Security::RevertToSelf() } == 0 { std::process::abort(); }
            self.active = false;
        }
    }
}
impl Drop for OwnerImpersonation { fn drop(&mut self) { self.restore(); } }
