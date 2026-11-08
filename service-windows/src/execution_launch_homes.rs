//! Bind the real original driver home selection to held source objects before
//! hashing the process descriptor. A path spelling is never home authority.
use crate::{
    execution,
    execution_context::DescriptorContext,
    execution_key::Key,
    execution_resource::{self, HeldLaunchHome},
};
use nessie_windows_common::{
    custody::REJECTED,
    execution::{Binding, Launch, ProcessPurpose},
    process::Process,
};
use std::path::Path;
pub fn hold(
    caller: &Process,
    context: &DescriptorContext,
    key: &Key,
    binding: &Binding,
    launch: &mut Launch,
) -> Result<Vec<HeldLaunchHome>, String> {
    launch.validate()?;
    let (graph, record) = execution::source_graph(key, binding)?;
    let homes = execution_resource::resolve_launch_homes(
        record["resourceId"].as_str().ok_or(REJECTED)?,
        caller,
        context,
        &graph,
    )?;
    let actual = Process::open(context.custody.runtime.pid)?;
    if actual.generation != context.custody.runtime || !actual.alive() {
        return Err(REJECTED.into());
    }
    if launch.process_purpose != ProcessPurpose::Provider && binding.driver != "claude" {
        return Err(REJECTED.into());
    }
    // Pinned CodexHomeLayout passes effectiveHomePath (shadow when present)
    // as CODEX_HOME; source producer binds that to the credential reference.
    // ClaudeHome sets CLAUDE_CONFIG_DIR explicitly and preserves HOME/USERPROFILE.
    let variable = match binding.driver.as_str() {
        "codex" => "CODEX_HOME",
        "claude" => "CLAUDE_CONFIG_DIR",
        _ => return Err(REJECTED.into()),
    };
    let matches = launch
        .environment
        .keys()
        .filter(|key| key.eq_ignore_ascii_case(variable))
        .cloned()
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(REJECTED.into());
    }
    let variable = &matches[0];
    let candidate = launch.environment.get(variable).ok_or(REJECTED)?;
    if candidate.is_empty() {
        return Err(REJECTED.into());
    }
    let selected =
        execution_resource::match_launch_home(&actual, Path::new(candidate), &homes.credential)?;
    selected.recheck()?;
    // A retained drive-letter spelling does not pin its DOS device map. Use the
    // actual volume-GUID path from the authenticated held object for execution.
    let canonical = selected
        .canonical_path()?
        .to_str()
        .ok_or(REJECTED)?
        .to_owned();
    launch.environment.insert(variable.clone(), canonical);
    Ok(vec![selected])
}
