//! Duplicated local destination objects. No receipt here authorizes a mutation.
use nessie_windows_common::{
    custody::REJECTED,
    execution_destination::{self as layout, FileReceipt, Receipt},
    execution_resource::{Object, Receipt as ResourceReceipt},
    execution_resource_handles::{check_watches, Duplicator, HeldCandidateDirectory, HeldObject},
    process::{Owned, Process},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
#[path = "execution_destination_read.rs"]
mod read;
#[path = "execution_destination_legacy_shell.rs"]
mod legacy_shell;
#[path = "execution_destination_lineage.rs"]
mod lineage;
#[path = "execution_destination_recovery_inputs.rs"]
mod recovery_inputs;
#[path = "execution_destination_shutdown.rs"]
mod shutdown;
pub(super) use lineage::BoundObservation;

static RETIRED: OnceLock<Mutex<Vec<(Process, Destination)>>> = OnceLock::new();
/// Source loss is not SQL teardown proof. Retain namespace/writer pins until
/// the actual graph process has ended if explicit drained close was unavailable.
pub(super) fn retire(destination: Destination, graph: Process) {
    if graph.alive() {
        RETIRED
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
            .unwrap_or_else(|_| std::process::abort())
            .push((graph, destination));
    }
}
pub(super) fn cleanup_retired() {
    if let Some(retired) = RETIRED.get() {
        if let Ok(mut held) = retired.lock() {
            held.retain(|(graph, _)| graph.alive());
        }
    }
}
pub(super) fn release_graph(generation: &nessie_windows_common::custody::Generation) -> Result<(), String> {
    if let Some(retired) = RETIRED.get() {
        let mut held = retired.lock().map_err(|_| REJECTED)?;
        if held
            .iter()
            .any(|(graph, _)| graph.generation == *generation && graph.alive())
        {
            return Err(REJECTED.into());
        }
        held.retain(|(graph, _)| graph.generation != *generation);
    }
    Ok(())
}

pub(super) struct Destination {
    pub receipt: Receipt,
    directory: HeldCandidateDirectory,
    writer: HeldObject,
    files: HashMap<String, HeldObject>,
    watches: Vec<Owned>,
    owner: String,
}
impl Destination {
    pub fn observe_shutdown(&self, generation: &str, settings: &[u8], selection_at_ms: u64,
        deadline: std::time::Instant) -> Result<nessie_windows_common::execution_shutdown::Observation, String> {
        let value = shutdown::observe(self.stage(generation)?, &self.owner, settings, selection_at_ms, deadline)?;
        self.recheck()?; Ok(value)
    }
    pub fn observe_recovery_inputs(&self, generation: &str, thread: &str)
        -> Result<nessie_windows_common::execution_recovery_inputs::Observation, String> {
        let value = recovery_inputs::read(self.stage(generation)?, &self.owner, thread)?;
        self.recheck()?; Ok(value)
    }
    pub fn stage_identity(&self, generation: &str) -> Result<String, String> {
        Ok(self.stage(generation)?.description.identity.clone())
    }
    fn stage(&self, generation: &str) -> Result<&HeldObject, String> {
        self.files.get(&self.stage_reference(generation)?).ok_or_else(|| REJECTED.into())
    }
    pub fn accept_initial_command(&self, graph: &nessie_windows_common::execution::Graph,
        first: &nessie_windows_common::execution_command_lineage::Initial, run: &str)
        -> Result<nessie_windows_common::execution_command_lineage::AcceptedInitial, String> {
        let result = lineage::accept_initial(self.stage(&graph.binding.source_generation)?, &self.owner, graph, first, run)?;
        self.recheck()?; Ok(result)
    }
    pub fn accept_release_command(&self, graph: &nessie_windows_common::execution::Graph,
        first: &nessie_windows_common::execution_command_lineage::Initial,
        accepted: &nessie_windows_common::execution_command_lineage::AcceptedInitial, release: &str)
        -> Result<nessie_windows_common::execution_command_lineage::AcceptedRelease, String> {
        let result = lineage::accept_release(self.stage(&graph.binding.source_generation)?, &self.owner, graph, first, accepted, release)?;
        self.recheck()?; Ok(result)
    }
    pub fn observe_bound_effect(&self, graph: &nessie_windows_common::execution::Graph,
        evidence: nessie_windows_common::execution_command_lineage::Evidence, effect: &str)
        -> Result<Option<BoundObservation>, String> {
        let result = lineage::observe(self.stage(&graph.binding.source_generation)?, &self.owner, graph, evidence, effect)?;
        self.recheck()?; Ok(result)
    }
    pub fn open(
        caller: &Process,
        resource: &ResourceReceipt,
        nonce: &str,
        directory: &Object,
        writer: &Object,
        watches: Vec<u64>,
    ) -> Result<Self, String> {
        let expected = layout::directory(
            &nessie_windows_common::process::profile_directory(caller)?,
            &resource.evidence.source.executor_id,
            &resource.evidence.source.physical_root_key,
        )?;
        Self::from_directory(caller, resource, nonce, directory, writer, watches, &expected)
    }
    pub(super) fn from_directory(
        caller: &Process,
        resource: &ResourceReceipt,
        nonce: &str,
        directory: &Object,
        writer: &Object,
        watches: Vec<u64>,
        expected: &std::path::Path,
    ) -> Result<Self, String> {
        let pinned = HeldCandidateDirectory::open(expected, &caller.sid)?;
        let duplicate = Duplicator::new(caller)?;
        let directory = duplicate.file(directory, &caller.sid)?;
        if directory.description.identity != pinned.identity()
            || directory.directory_path(&caller.sid)? != pinned.canonical_path()?
        {
            return Err(REJECTED.into());
        }
        let writer = duplicate.file(writer, &caller.sid)?;
        if writer.single_file_path(&caller.sid)? != pinned.canonical_path()?.join(layout::WRITER_FILE) {
            return Err(REJECTED.into());
        }
        let watches = watches
            .into_iter()
            .map(|handle| duplicate.duplicate(handle))
            .collect::<Result<Vec<_>, _>>()?;
        let runtime_generation = format!(
            "destination-sha256:{:x}",
            Sha256::digest(
                format!(
                    "{}:{}:{}:{}",
                    nonce,
                    resource.resource_generation,
                    pinned.identity(),
                    writer.description.identity
                )
                .as_bytes()
            )
        );
        let result = Self {
            receipt: Receipt {
                version: 1,
                resource_id: resource.resource_id.clone(),
                resource_generation: resource.resource_generation.clone(),
                runtime_generation,
                directory_identity: pinned.identity().into(),
                writer_identity: writer.description.identity.clone(),
            },
            directory: pinned,
            writer,
            files: HashMap::new(),
            watches,
            owner: caller.sid.clone(),
        };
        result.recheck()?;
        Ok(result)
    }
    pub fn hold_file(&mut self, caller: &Process, reference: &str, file: &Object) -> Result<FileReceipt, String> {
        self.recheck()?;
        let name = layout::filename(reference)?;
        if self.files.len() >= 65 && !self.files.contains_key(reference) {
            return Err(REJECTED.into());
        }
        let file = Duplicator::new(caller)?.file(file, &self.owner)?;
        let path = file.single_file_path(&self.owner)?;
        if path != self.directory.canonical_path()?.join(name)
            || file.description.identity == self.writer.description.identity
            || self
                .files
                .iter()
                .any(|(key, old)| key != reference && old.description.identity == file.description.identity)
        {
            return Err(REJECTED.into());
        }
        if let Some(previous) = self.files.get(reference) {
            if previous.description.identity != file.description.identity {
                return Err(REJECTED.into());
            }
        } else {
            self.files.insert(reference.into(), file);
        }
        self.recheck()?;
        Ok(FileReceipt {
            version: 1,
            runtime_generation: self.receipt.runtime_generation.clone(),
            reference: reference.into(),
            database_identity: self.files.get(reference).ok_or(REJECTED)?.description.identity.clone(),
        })
    }
    pub fn recheck(&self) -> Result<(), String> {
        check_watches(&self.watches)?;
        self.directory.recheck()?;
        let directory = self.directory.canonical_path()?;
        if self.writer.single_file_path(&self.owner)? != directory.join(layout::WRITER_FILE) {
            return Err(REJECTED.into());
        }
        for (reference, file) in &self.files {
            if file.single_file_path(&self.owner)? != directory.join(layout::filename(reference)?) {
                return Err(REJECTED.into());
            }
        }
        check_watches(&self.watches)
    }
    pub fn stage_reference(&self, generation: &str) -> Result<String, String> {
        self.recheck()?;
        let reference = format!(
            "t3-capture:v1:{:x}",
            Sha256::digest(format!("nessie:t3-capture-stage:v1\0{generation}").as_bytes())
        );
        if !self.files.contains_key(&reference) || !self.files.contains_key(layout::JOURNAL_REFERENCE) {
            return Err(REJECTED.into());
        }
        Ok(reference)
    }
    pub fn observe_pending_effect(&self, generation: &str, thread: &str, effect: &str)
        -> Result<Option<nessie_windows_common::execution_pending_effect::Observation>, String> {
        let reference = self.stage_reference(generation)?;
        let result = read::observe(self.files.get(&reference).ok_or(REJECTED)?, &self.owner, thread, effect)?;
        self.recheck()?;
        Ok(result)
    }
    pub fn observe_process_loss(&self, generation: &str)
        -> Result<nessie_windows_common::execution_process_loss::Observation, String> {
        let result = read::process_loss(self.stage(generation)?, &self.owner)?;
        self.recheck()?;
        Ok(result)
    }
    pub fn observe_legacy_shells(&self, generation: &str)
        -> Result<nessie_windows_common::execution_legacy_shell::Observation, String> {
        let result = legacy_shell::observe(self.stage(generation)?, &self.owner)?;
        self.recheck()?;
        Ok(result)
    }
}
