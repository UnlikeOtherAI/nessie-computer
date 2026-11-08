//! Actual launch descriptors and executable handles remain service-held until
//! their managed graph ends. A journal entry alone cannot recreate this proof.
use crate::execution::image_digest;
use crate::execution_key::{canonical, sha};
use nessie_windows_common::{
    custody::REJECTED,
    custody_observation::absent,
    execution::{Descriptor, Launch, ProcessPurpose},
    release::{pin_execution_image, Release},
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs::File, path::Path, sync::Mutex};
struct Prepared {
    descriptor: Descriptor,
    launch_digest: String,
    _image: File,
    launch: Launch,
    homes: Vec<crate::execution_resource::HeldLaunchHome>,
}
static PREPARED: Mutex<BTreeMap<String, Prepared>> = Mutex::new(BTreeMap::new());
pub fn hold(
    id: &str,
    descriptor: &Descriptor,
    release: &Release,
    launch: Launch,
    homes: Vec<crate::execution_resource::HeldLaunchHome>,
) -> Result<Value, String> {
    launch.validate()?;
    if homes.is_empty() {
        return Err(REJECTED.into());
    }
    for home in &homes {
        home.recheck()?;
    }
    let mut environment_names = std::collections::BTreeSet::new();
    if launch
        .environment
        .keys()
        .any(|name| !environment_names.insert(name.to_uppercase()))
    {
        return Err(REJECTED.into());
    }
    if launch.process_purpose != ProcessPurpose::Provider {
        // A fixed immutable history entry cannot acquire an alternate Node
        // loader through the original environment.
        if launch.environment.iter().any(|(name, value)| {
            matches!(name.to_uppercase().as_str(), "NODE_OPTIONS" | "NODE_PATH")
                && !value.is_empty()
        }) {
            return Err(REJECTED.into());
        }
        let history = launch.history.as_ref().ok_or(REJECTED)?;
        let bundle = release
            .runtime
            .bundle()
            .to_str()
            .ok_or(REJECTED)?
            .to_owned();
        if Path::new(&launch.command) != release.runtime.node_executable
            || launch.args
                != vec![
                    bundle,
                    "t3-session-history".into(),
                    history.method.clone(),
                    history.session_id.clone(),
                    history.raw_options.clone(),
                ]
            || launch
                .environment
                .get("ELECTRON_RUN_AS_NODE")
                .map(String::as_str)
                != Some("1")
        {
            return Err(REJECTED.into());
        }
    }
    let image = pin_execution_image(Path::new(&launch.command))?;
    let digest = image_digest(image.try_clone().map_err(|_| REJECTED)?)?;
    let launch_digest =
        sha(canonical(&serde_json::to_value(&launch).map_err(|_| REJECTED)?)?.as_bytes());
    let result = json!({"launchDigest":launch_digest,"command":launch.command,"providerImageDigest":digest,
            "processPurpose":launch.process_purpose});
    let mut held = PREPARED.lock().map_err(|_| REJECTED)?;
    held.retain(|_, value| !absent(&value.descriptor.custody.runtime).unwrap_or(false));
    if held.len() >= 256 || held.contains_key(id) {
        return Err(REJECTED.into());
    }
    held.insert(
        id.into(),
        Prepared {
            descriptor: descriptor.clone(),
            launch_digest,
            _image: image,
            launch,
            homes,
        },
    );
    Ok(result)
}
pub fn selected(id: &str, descriptor: &Descriptor, digest: &str) -> Result<Launch, String> {
    recheck(id, descriptor, digest)?;
    let held = PREPARED.lock().map_err(|_| REJECTED)?;
    Ok(held.get(id).ok_or(REJECTED)?.launch.clone())
}
pub fn recheck(id: &str, descriptor: &Descriptor, digest: &str) -> Result<(), String> {
    let held = PREPARED.lock().map_err(|_| REJECTED)?;
    let held = held.get(id).ok_or(REJECTED)?;
    if held.descriptor != *descriptor || held.launch_digest != digest {
        return Err(REJECTED.into());
    }
    for home in &held.homes {
        home.recheck()?;
    }
    Ok(())
}
