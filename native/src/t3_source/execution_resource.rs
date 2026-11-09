//! Fixed protected graph child. No request may supply evidence, handles or paths
//! to providers; only the configured admitted T3 root is selected by key.
use super::{handles::{fail, Held}, lease::LeaseClock, resource::Resource, execution_settings::Settings,
    consent_state::random_id, pipe::{self, Session}};
use crate::protocol::NativeError;
use nessie_windows_common::{custody::Operation, execution::Custody,
    execution_resource::{Evidence, Receipt, Request, Source}};
use serde_json::{json, Value};
use std::{io::Read, sync::Arc};
use base64::Engine;

const PIN: Option<&str> = option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");
pub(super) fn service(request: Request) -> Result<Value, NativeError> {
    request.validate().map_err(|_| fail())?;
    nessie_windows_common::service_channel::call(&Operation::ExecutionResource { request: Box::new(request) }, PIN)
        .map_err(|_| fail())
}
struct ExecutionResource {
    source: Resource,
    settings: Settings,
    _configuration: Held,
    receipt: Receipt,
    snapshot: super::execution_snapshot::Snapshot,
    closed: bool,
    destination: Option<super::execution_destination::Destination>,
    destination_closed: bool,
}
impl ExecutionResource {
    fn recheck(&self) -> Result<(), NativeError> {
        if self.closed { return Err(fail()); }
        self.source.recheck()?;
        self.settings.recheck()?;
        if let Some(destination) = &self.destination { destination.recheck()?; }
        let response = service(Request::Recheck { executor_id: self.receipt.evidence.source.executor_id.clone(),
            resource_id: self.receipt.resource_id.clone() })?;
        if response["resourceId"] != self.receipt.resource_id
            || response["resourceGeneration"] != self.receipt.resource_generation { return Err(fail()); }
        self.settings.recheck()?;
        self.source.recheck()
    }
    fn close(&mut self) -> Result<(), NativeError> {
        if self.closed { return Ok(()); }
        self.closed = true;
        service(Request::Close { executor_id: self.receipt.evidence.source.executor_id.clone(),
            resource_id: self.receipt.resource_id.clone() })?;
        Ok(())
    }
}
impl Session for ExecutionResource {
    fn dispatch(&mut self, request: &Value) -> Result<Value, NativeError> {
        let fields = request.as_object().ok_or_else(fail)?;
        self.recheck()?;
        let result = match request["op"].as_str().ok_or_else(fail)? {
            "executionSnapshotOpen" | "executionSnapshotRead" | "executionSnapshotClose" =>
                self.snapshot.dispatch(request, &mut self.source),
            "executionDescribe" if fields.len() == 1 => Ok(json!({"receipt":self.receipt,
                "settingsBase64":base64::engine::general_purpose::STANDARD.encode(self.settings.bytes()?)})),
            "recheck" if fields.len() == 1 => Ok(json!({})),
            "executionDestinationOpen" if fields.len() == 1 => {
                if self.destination.is_some() || self.destination_closed { return Err(fail()); }
                let destination = super::execution_destination::Destination::open(&self.receipt)?;
                let answer = json!({"receipt":destination.receipt,"directory":destination.directory()?});
                self.destination = Some(destination);
                Ok(answer)
            },
            "executionDestinationHoldFile" if fields.len() == 2 => {
                let reference = request["reference"].as_str().ok_or_else(fail)?;
                let destination = self.destination.as_mut().ok_or_else(fail)?;
                Ok(json!({"receipt":destination.hold_file(&self.receipt, reference)?}))
            },
            "executionDestinationObserveEffect" if fields.len() == 3 => {
                self.destination.as_ref().ok_or_else(fail)?.recheck()?;
                let graph = serde_json::from_value(request["graph"].clone()).map_err(|_| fail())?;
                let effect_id = request["effectId"].as_str().ok_or_else(fail)?.to_owned();
                service(Request::ObserveDestinationEffect { executor_id: self.receipt.evidence.source.executor_id.clone(),
                    resource_id: self.receipt.resource_id.clone(), graph, effect_id })
            },
            "executionDestinationObserveProcessLoss" if fields.len() == 2 => {
                self.destination.as_ref().ok_or_else(fail)?.recheck()?;
                let graph = serde_json::from_value(request["graph"].clone()).map_err(|_| fail())?;
                service(Request::ObserveDestinationProcessLoss {
                    executor_id: self.receipt.evidence.source.executor_id.clone(),
                    resource_id: self.receipt.resource_id.clone(), graph })
            },
            "executionDestinationObserveLegacyShells" if fields.len() == 2 => {
                self.destination.as_ref().ok_or_else(fail)?.recheck()?;
                let graph = serde_json::from_value(request["graph"].clone()).map_err(|_| fail())?;
                service(Request::ObserveDestinationLegacyShells {
                    executor_id: self.receipt.evidence.source.executor_id.clone(),
                    resource_id: self.receipt.resource_id.clone(), graph })
            },
            "executionDestinationObserveRecoveryInputs" if fields.len() == 3 => {
                self.destination.as_ref().ok_or_else(fail)?.recheck()?;
                let graph = serde_json::from_value(request["graph"].clone()).map_err(|_| fail())?;
                let thread_id = request["threadId"].as_str().ok_or_else(fail)?.to_owned();
                service(Request::ObserveDestinationRecoveryInputs {
                    executor_id: self.receipt.evidence.source.executor_id.clone(),
                    resource_id: self.receipt.resource_id.clone(), graph, thread_id })
            },
            "executionLegacyShellPrepare" if fields.len() == 3 => {
                self.destination.as_ref().ok_or_else(fail)?.recheck()?;
                let graph = serde_json::from_value(request["graph"].clone()).map_err(|_| fail())?;
                let not_after_ms = request["notAfterMs"].as_u64().ok_or_else(fail)?;
                service(Request::PrepareLegacyShells { executor_id: self.receipt.evidence.source.executor_id.clone(),
                    resource_id: self.receipt.resource_id.clone(), graph, not_after_ms })
            },
            "executionLegacyShellConsume" if fields.len() == 3 => {
                self.destination.as_ref().ok_or_else(fail)?.recheck()?;
                let graph = serde_json::from_value(request["graph"].clone()).map_err(|_| fail())?;
                let admission = serde_json::from_value(request["admission"].clone()).map_err(|_| fail())?;
                service(Request::ConsumeLegacyShells { executor_id: self.receipt.evidence.source.executor_id.clone(),
                    resource_id: self.receipt.resource_id.clone(), graph, admission })
            },
            "executionCommandOpen" if fields.len() == 3 => {
                self.destination.as_ref().ok_or_else(fail)?.recheck()?;
                let graph = serde_json::from_value(request["graph"].clone()).map_err(|_| fail())?;
                let retention_expires_at = request["retentionExpiresAt"].as_u64().ok_or_else(fail)?;
                service(Request::OpenCommandLineage { executor_id: self.receipt.evidence.source.executor_id.clone(),
                    resource_id: self.receipt.resource_id.clone(), graph, retention_expires_at })
            },
            "executionCommandRecord" if fields.len() == 3 => {
                self.destination.as_ref().ok_or_else(fail)?.recheck()?;
                let graph = serde_json::from_value(request["graph"].clone()).map_err(|_| fail())?;
                let edge = serde_json::from_value(request["edge"].clone()).map_err(|_| fail())?;
                service(Request::RecordCommandLineage { executor_id: self.receipt.evidence.source.executor_id.clone(),
                    resource_id: self.receipt.resource_id.clone(), graph, edge })
            },
            "executionCommandClose" if fields.len() == 2 => {
                let graph = serde_json::from_value(request["graph"].clone()).map_err(|_| fail())?;
                service(Request::CloseCommandLineage { executor_id: self.receipt.evidence.source.executor_id.clone(),
                    resource_id: self.receipt.resource_id.clone(), graph })
            },
            "executionDestinationObserveBoundEffect" if fields.len() == 3 => {
                self.destination.as_ref().ok_or_else(fail)?.recheck()?;
                let graph = serde_json::from_value(request["graph"].clone()).map_err(|_| fail())?;
                let effect_id = request["effectId"].as_str().ok_or_else(fail)?.to_owned();
                service(Request::ObserveBoundDestinationEffect { executor_id: self.receipt.evidence.source.executor_id.clone(),
                    resource_id: self.receipt.resource_id.clone(), graph, effect_id })
            },
            "executionEffectClaimPrepare" if fields.len() == 3 => {
                self.destination.as_ref().ok_or_else(fail)?.recheck()?;
                let graph = serde_json::from_value(request["graph"].clone()).map_err(|_| fail())?;
                let effect_id = request["effectId"].as_str().ok_or_else(fail)?.to_owned();
                service(Request::PrepareEffectClaim { executor_id: self.receipt.evidence.source.executor_id.clone(),
                    resource_id: self.receipt.resource_id.clone(), graph, effect_id })
            },
            "executionEffectClaimConsume" if fields.len() == 3 => {
                self.destination.as_ref().ok_or_else(fail)?.recheck()?;
                let graph = serde_json::from_value(request["graph"].clone()).map_err(|_| fail())?;
                let admission = serde_json::from_value(request["admission"].clone()).map_err(|_| fail())?;
                service(Request::ConsumeEffectClaim { executor_id: self.receipt.evidence.source.executor_id.clone(),
                    resource_id: self.receipt.resource_id.clone(), graph, admission })
            },
            "executionDestinationClose" if fields.len() == 1 => {
                service(Request::CloseDestination { executor_id: self.receipt.evidence.source.executor_id.clone(),
                    resource_id: self.receipt.resource_id.clone() })?;
                self.destination_closed = true;
                self.destination = None;
                Ok(json!({"closed":true}))
            },
            "close" if fields.len() == 1 => { self.close()?; return Ok(json!({})); },
            _ => Err(fail()),
        }?;
        // Rows cross the protected channel only after current service-held
        // registration, settings, owner ACL and graph custody are rechecked.
        self.recheck()?;
        Ok(result)
    }
    fn renew(&self) -> Result<(), NativeError> {
        if self.closed { return Ok(()); }
        self.recheck()?; self.source.renew()
    }
}
impl Drop for ExecutionResource { fn drop(&mut self) { let _ = self.close(); } }

pub(super) fn run() -> Result<(), NativeError> {
    if !cfg!(target_arch = "x86_64") { return Err(fail()); }
    nessie_windows_provenance::require_release_signature(PIN).map_err(|_| fail())?;
    let clock = Arc::new(LeaseClock::new());
    let watchdog = clock.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if watchdog.check().is_err() { std::process::exit(1); }
    });
    let mut bytes = Vec::new();
    std::io::stdin().take(65537).read_to_end(&mut bytes).map_err(|_| fail())?;
    if bytes.len() > 65536 { return Err(fail()); }
    let request: Value = serde_json::from_slice(&bytes).map_err(|_| fail())?;
    let executor = request["executorId"].as_str().ok_or_else(fail)?.to_owned();
    let context = service(Request::Authorize { executor_id: executor.clone() })?;
    let custody: Custody = serde_json::from_value(context["custody"].clone()).map_err(|_| fail())?;
    if request["parentPid"].as_u64() != Some(custody.runtime.pid as u64) { return Err(fail()); }
    nessie_windows_common::peer_inspection::allow_execution_pipe_observer().map_err(|_| fail())?;
    let key = request["admittedRootKey"].as_str().ok_or_else(fail)?;
    let resource_id = random_id()?;
    let registration = super::execution_link::Registration::open(&executor, key, clock.clone())?;
    registration.require_link(&executor, key, &resource_id)?;
    let source = Resource::open_with_clock(&registration.request, clock)?;
    let configuration = source.execution_configuration()?;
    let source_objects = source.execution_objects(&configuration);
    registration.handoff(&source, &configuration)?;
    drop(registration);
    let settings = Settings::open(source.execution_root()?)?;
    let description = &source.description;
    let raw = &description["source"];
    let string = |v: &Value| v.as_str().map(str::to_owned).ok_or_else(fail);
    let evidence = Evidence { source: Source { executor_id: executor.clone(),
        admitted_root_key: string(&raw["admittedRootKey"])?, physical_root_key: string(&raw["physicalRootKey"])?,
        environment_id: string(&raw["environmentId"])?, database_identity: string(&description["databaseIdentity"])?,
        environment_identity: string(&description["environmentIdentity"])?, layout: string(&raw["layout"])?,
        database_role: string(&raw["databaseRole"])? }, settings_identity: settings.identity().to_owned(),
        settings_digest: settings.digest().to_owned(), settings_length: settings.length(),
        provider_references: settings.references().to_vec() };
    let mut objects = source_objects; objects.extend(settings.objects());
    let mut watches = source.execution_watches(); watches.extend(settings.watches());
    let result = service(Request::Register { executor_id: executor.clone(), resource_id: resource_id.clone(),
        evidence: evidence.clone(), objects, watches });
    let receipt: Receipt = match result.and_then(|value| serde_json::from_value::<Receipt>(value).map_err(|_| fail())) {
        Ok(receipt) if receipt.version == 1 && receipt.resource_id == resource_id
            && receipt.evidence == evidence && receipt.custody == custody => receipt,
        _ => { let _ = service(Request::Close { executor_id: executor, resource_id }); return Err(fail()); }
    };
    let session = ExecutionResource { source, settings, _configuration: configuration, receipt,
        snapshot: Default::default(), closed: false, destination: None, destination_closed: false };
    session.recheck()?;
    pipe::serve_session(&request, session)
}
