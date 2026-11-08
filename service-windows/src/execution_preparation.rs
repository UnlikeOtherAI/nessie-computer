//! Actual launch descriptors and executable handles remain service-held until
//! their managed graph ends. A journal entry alone cannot recreate this proof.
use crate::execution::image_digest;
use crate::execution_key::{canonical, sha};
use nessie_windows_common::{
    custody::REJECTED,
    custody_observation::absent,
    execution::{Descriptor, Launch},
    release::pin_execution_image,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs::File, path::Path, sync::Mutex};
struct Prepared {
    descriptor: Descriptor,
    launch_digest: String,
    _image: File,
    _launch: Launch,
}
static PREPARED: Mutex<BTreeMap<String, Prepared>> = Mutex::new(BTreeMap::new());
pub fn hold(id: &str, descriptor: &Descriptor, launch: Launch) -> Result<Value, String> {
    launch.validate()?;
    let image = pin_execution_image(Path::new(&launch.command))?;
    let digest = image_digest(image.try_clone().map_err(|_| REJECTED)?)?;
    let launch_digest =
        sha(canonical(&serde_json::to_value(&launch).map_err(|_| REJECTED)?)?.as_bytes());
    let result =
        json!({"launchDigest":launch_digest,"command":launch.command,"providerImageDigest":digest});
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
            _launch: launch,
        },
    );
    Ok(result)
}
pub fn recheck(id: &str, descriptor: &Descriptor, digest: &str) -> Result<(), String> {
    let held = PREPARED.lock().map_err(|_| REJECTED)?;
    let held = held.get(id).ok_or(REJECTED)?;
    if held.descriptor != *descriptor || held.launch_digest != digest {
        return Err(REJECTED.into());
    }
    Ok(())
}
