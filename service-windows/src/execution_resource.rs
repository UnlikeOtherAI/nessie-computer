//! Service-owned duplicated source handles, scoped to one protected graph.
use crate::execution_context::{self, DescriptorContext};
use nessie_windows_common::{custody::REJECTED, custody_store::State,
    execution::{Binding, Custody, Graph}, execution_resource::{Evidence, Receipt, Request, LEASE_MILLIS, SETTINGS_LIMIT},
    execution_resource_handles::{check_watches, Duplicator, HeldObject}, process::{Owned, Process}, release::Release};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path, sync::{Mutex, OnceLock}, time::{Duration, Instant}};

struct Held {
    receipt: Receipt,
    caller: Process,
    objects: Vec<HeldObject>,
    watches: Vec<Owned>,
    deadline: Instant,
    config_digest: Vec<u8>,
    graph_generation: Option<(String, String)>,
    inspections: HashMap<String, String>,
    paired_origin: String,
    service_root: std::path::PathBuf,
}
#[path = "execution_resource_link.rs"]
mod link;
#[path = "execution_resource_homes.rs"]
mod homes;
pub(crate) use homes::{resolve_launch_homes, match_launch_home, ResolvedLaunchHome, ResolvedLaunchHomes, HeldLaunchHome};
static RESOURCES: OnceLock<Mutex<HashMap<String, Held>>> = OnceLock::new();
#[cfg(test)]
#[path = "execution_resource_tests.rs"]
mod tests;
fn resources() -> &'static Mutex<HashMap<String, Held>> {
    RESOURCES.get_or_init(|| {
        // Duplicate handles must not retain source locks indefinitely after
        // helper/process loss, even if nobody makes another service request.
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_millis(250));
            if let Some(resources) = RESOURCES.get() {
                if let Ok(mut held) = resources.lock() { held.retain(|_, h| h.recheck().is_ok()); }
                link::cleanup();
            }
        });
        Mutex::new(HashMap::new())
    })
}
fn same_graph(a: &Custody, b: &Custody) -> bool {
    // Each native helper is a distinct child of this exact graph incarnation.
    a.runtime == b.runtime && a.controller == b.controller && a.supervisor == b.supervisor && a.service == b.service
        && a.job_name == b.job_name && a.release_digest == b.release_digest
        && a.service_image_digest == b.service_image_digest
}
impl Held {
    fn check_binding(&self, caller: &Process, context: &DescriptorContext, b: &Binding) -> Result<(), String> {
        let evidence: &Evidence = &self.receipt.evidence;
        if !caller.alive() || caller.sid != self.caller.sid || caller.session != self.caller.session
            || self.paired_origin != context.paired_origin || !same_graph(&self.receipt.custody, &context.custody)
            || b.executor_id != evidence.source.executor_id || b.environment_id != evidence.source.environment_id
            || b.source_root_key != evidence.source.physical_root_key { return Err(REJECTED.into()); }
        for (role, reference) in [("history", &b.history_home_key), ("continuation", &b.continuation_home_key),
            ("credential", &b.credential_binding_id)] {
            if !evidence.provider_references.iter().any(|r| r.role == role && &r.reference_id == reference
                && r.instance_id == b.provider_instance_id && r.driver == b.driver) { return Err(REJECTED.into()); }
        }
        let generation = (b.runtime_generation.clone(), b.source_generation.clone());
        if self.graph_generation.as_ref().is_some_and(|old| old != &generation) { return Err(REJECTED.into()); }
        Ok(())
    }
    fn object(&self, kind: &str) -> Result<&HeldObject, String> {
        let mut found = self.objects.iter().filter(|o| o.description.kind == kind);
        let first = found.next().ok_or(REJECTED)?;
        if found.next().is_some() { return Err(REJECTED.into()); }
        Ok(first)
    }
    fn recheck(&self) -> Result<(), String> {
        self.recheck_objects()?;
        link::require_link(&self.service_root, &self.receipt.evidence.source.executor_id,
            &self.caller, &self.receipt.evidence.source.admitted_root_key,
            self.object("configuration")?, self.object("source-root")?)
    }
    fn recheck_objects(&self) -> Result<(), String> {
        if Instant::now() >= self.deadline || !self.caller.alive() { return Err(REJECTED.into()); }
        for generation in [&self.receipt.custody.runtime, &self.receipt.custody.supervisor] {
            let observed = Process::open(generation.pid)?;
            if !observed.alive() || observed.generation != *generation { return Err(REJECTED.into()); }
        }
        check_watches(&self.watches)?;
        for object in &self.objects { object.recheck(&self.caller.sid)?; }
        // settings/config reads use the duplicated file objects, not paths.
        let mut bytes = self.object("settings")?.bytes(SETTINGS_LIMIT)?;
        let correct = bytes.len() == self.receipt.evidence.settings_length
            && format!("{:x}", Sha256::digest(&bytes)) == self.receipt.evidence.settings_digest;
        bytes.fill(0);
        if !correct { return Err(REJECTED.into()); }
        let mut config = self.object("configuration")?.bytes(256 * 1024)?;
        let correct = Sha256::digest(&config).as_slice() == self.config_digest.as_slice();
        config.fill(0);
        if !correct { return Err(REJECTED.into()); }
        check_watches(&self.watches)
    }
    fn validate_source(&self) -> Result<(), String> {
        let e = &self.receipt.evidence;
        let root = self.object("source-root")?;
        if e.source.physical_root_key != format!("windows-file-id:{:x}", Sha256::digest(root.description.identity.as_bytes()))
            || self.object("database")?.description.identity != e.source.database_identity
            || self.object("environment")?.description.identity != e.source.environment_identity
            || self.object("settings")?.description.identity != e.settings_identity {
            return Err(REJECTED.into());
        }
        let bytes = self.object("environment")?.bytes(4096)?;
        if std::str::from_utf8(&bytes).map_err(|_| REJECTED)?.trim() != e.source.environment_id {
            return Err(REJECTED.into());
        }
        for reference in &e.provider_references {
            if !self.objects.iter().any(|o| o.description.kind == "provider-home"
                && o.description.identity == reference.identity) { return Err(REJECTED.into()); }
        }
        Ok(())
    }
}

/// Called under custody's admission mutex and update machine barrier. The peer
/// and immutable release are observed by that dispatcher, not deserialized.
pub fn handle(root: &Path, caller: &Process, release: &Release, state: &State, request: Request) -> Result<Value, String> {
    request.validate()?;
    execution_context::require_companion_role(caller, release, state,
        nessie_windows_common::execution_creator::CompanionRole::Resource)?;
    let context = execution_context::authenticate_graph(root, caller, release, state, request.executor())?;
    let mut resources = resources().lock().map_err(|_| REJECTED)?;
    resources.retain(|_, h| h.recheck().is_ok());
    match request {
        Request::Authorize { .. } => Ok(json!({"custody":context.custody})),
        Request::ReviewRegistration { executor_id, review_id, admitted_root_key, configuration, source_root } =>
            link::review(root, caller, &executor_id, &review_id, &admitted_root_key, &configuration, &source_root),
        Request::LinkRegistration { executor_id, review_id, review_digest } =>
            link::confirm(caller, &executor_id, &review_id, &review_digest),
        Request::Register { executor_id: _, resource_id, evidence, objects, watches } => {
            if resources.len() >= 64 || resources.contains_key(&resource_id) { return Err(REJECTED.into()); }
            let duplicate = Duplicator::new(caller)?;
            let objects = objects.iter().map(|o| duplicate.file(o, &caller.sid)).collect::<Result<Vec<_>, _>>()?;
            let watches = watches.into_iter().map(|h| duplicate.duplicate(h)).collect::<Result<Vec<_>, _>>()?;
            let observed = Process::open(caller.generation.pid)?;
            if observed.generation != caller.generation { return Err(REJECTED.into()); }
            // A random native resource ID names this single live registration.
            // It is not a historical identity or a runtime writer generation.
            let generation = format!("sha256:{:x}", Sha256::digest(format!("{}:{}:{}:{}", resource_id,
                caller.generation.boot_id, caller.generation.pid, caller.generation.started_at).as_bytes()));
            let mut held = Held { receipt: Receipt { version: 1, resource_id: resource_id.clone(),
                resource_generation: generation, evidence, custody: context.custody }, caller: observed,
                objects, watches, deadline: Instant::now() + Duration::from_millis(LEASE_MILLIS),
                config_digest: Vec::new(), graph_generation: None, inspections: HashMap::new(),
                paired_origin: context.paired_origin, service_root: root.into() };
            let mut config = held.object("configuration")?.bytes(256 * 1024)?;
            let parsed: Value = serde_json::from_slice(&config).map_err(|_| REJECTED)?;
            held.config_digest = Sha256::digest(&config).to_vec();
            config.fill(0);
            if parsed["executorId"] != held.receipt.evidence.source.executor_id
                || !parsed["t3SourceHomes"].as_array().is_some_and(|homes| homes.iter().any(|home|
                    home["admittedRootKey"] == held.receipt.evidence.source.admitted_root_key)) {
                return Err(REJECTED.into());
            }
            held.validate_source()?;
            held.recheck()?;
            let answer = serde_json::to_value(&held.receipt).map_err(|_| REJECTED)?;
            resources.insert(resource_id, held);
            Ok(answer)
        }
        Request::Recheck { resource_id, .. } => {
            let held = resources.get_mut(&resource_id).ok_or(REJECTED)?;
            if held.caller.generation != caller.generation || held.paired_origin != context.paired_origin
                || !same_graph(&held.receipt.custody, &context.custody) {
                return Err(REJECTED.into());
            }
            held.recheck()?;
            held.deadline = Instant::now() + Duration::from_millis(LEASE_MILLIS);
            Ok(json!({"resourceId":resource_id,"resourceGeneration":held.receipt.resource_generation}))
        }
        Request::Close { resource_id, .. } => {
            if let Some(held) = resources.get(&resource_id) {
                if held.caller.generation != caller.generation { return Err(REJECTED.into()); }
            }
            resources.remove(&resource_id);
            Ok(json!({"closed":true}))
        }
    }
}

/// Binds an inspection nonce after backend verification. Later finite phases
/// recheck the identical accepted graph without renewing its authority.
pub fn bind_graph(resource_id: &str, caller: &Process, context: &DescriptorContext, graph: &Graph) -> Result<(), String> {
    let mut resources = resources().lock().map_err(|_| REJECTED)?;
    let result = (|| {
        let held = resources.get_mut(resource_id).ok_or(REJECTED)?;
        held.recheck()?;
        let digest = nessie_windows_common::execution::value_digest(&serde_json::to_value(graph).map_err(|_| REJECTED)?)?;
        match held.inspections.get(&graph.nonce) {
            Some(previous) if previous == &digest => (),
            Some(_) => return Err(REJECTED.into()),
            None => { graph.validate()?; if held.inspections.len() >= 256 { return Err(REJECTED.into()); } }
        }
        let b = &graph.binding;
        held.check_binding(caller, context, b)?;
        let generation = (b.runtime_generation.clone(), b.source_generation.clone());
        held.graph_generation = Some(generation);
        held.inspections.insert(graph.nonce.clone(), digest);
        held.recheck()
    })();
    if result.is_err() { resources.remove(resource_id); }
    result
}
