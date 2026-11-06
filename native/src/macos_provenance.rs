//! Publisher trust from Security.framework, including the actual loaded helper.
//! No shell tool, environment-selected binary or development exception.
use crate::protocol::NativeError;
use std::{ffi::{c_void, CString}, os::unix::ffi::OsStrExt, path::Path};

type Reference = *const c_void;
const STRICT: u32 = 1 << 4; // Security.framework/SecStaticCode.h
const UTF8: u32 = 0x0800_0100;
fn refused() -> NativeError { NativeError::new("EXECUTOR_MACOS_PUBLISHER_REJECTED") }

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecCodeCopySelf(flags: u32, code: *mut Reference) -> i32;
    fn SecCodeCopyGuestWithAttributes(host: Reference, attributes: Reference, flags: u32, code: *mut Reference) -> i32;
    static kSecGuestAttributePid: Reference;
    fn SecCodeCheckValidity(code: Reference, flags: u32, requirement: Reference) -> i32;
    fn SecRequirementCreateWithString(text: Reference, flags: u32, requirement: *mut Reference) -> i32;
    fn SecStaticCodeCreateWithPath(path: Reference, flags: u32, code: *mut Reference) -> i32;
    fn SecStaticCodeCheckValidity(code: Reference, flags: u32, requirement: Reference) -> i32;
    fn SecCodeCopySigningInformation(code: Reference, flags: u32, information: *mut Reference) -> i32;
    static kSecCodeInfoPList: Reference;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(allocator: Reference, bytes: *const i8, encoding: u32) -> Reference;
    fn CFURLCreateFromFileSystemRepresentation(allocator: Reference, bytes: *const u8,
        length: isize, directory: u8) -> Reference;
    fn CFRelease(value: Reference);
    fn CFNumberCreate(allocator: Reference, kind: i32, value: *const c_void) -> Reference;
    fn CFDictionaryCreate(allocator: Reference, keys: *const Reference, values: *const Reference,
        count: isize, key_callbacks: *const c_void, value_callbacks: *const c_void) -> Reference;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
    fn CFGetTypeID(value: Reference) -> usize;
    fn CFDictionaryGetTypeID() -> usize;
    fn CFDictionaryGetValue(dictionary: Reference, key: Reference) -> Reference;
    fn CFNumberGetTypeID() -> usize;
    fn CFNumberGetValue(number: Reference, kind: i32, value: *mut c_void) -> u8;
}

/// Only a sealed Developer ID app may declare an independent runtime consumer.
/// A missing floor remains an old entrypoint, even when it has the same publisher.
pub fn require_independent_app(path: &Path) -> Result<(), NativeError> {
    require_current_release()?;
    let code = static_file(path)?;
    let requirement = requirement(release_team()?)?;
    if unsafe { SecStaticCodeCheckValidity(code.0, STRICT, requirement.0) } != 0 { return Err(refused()); }
    // Read Code Signing Services' secured dictionary, never a second untrusted
    // filesystem read of Info.plist after checking the app's signature.
    let mut information = std::ptr::null();
    if unsafe { SecCodeCopySigningInformation(code.0, 0, &mut information) } != 0 { return Err(refused()); }
    let information = Owned::new(information)?;
    let dictionary = unsafe { CFDictionaryGetValue(information.0, kSecCodeInfoPList) };
    if dictionary.is_null() || unsafe { CFGetTypeID(dictionary) != CFDictionaryGetTypeID() } { return Err(refused()); }
    for (name, expected) in [("NessieExecutorManagedLaunchProtocol", 1),
        ("NessieExecutorPersonalInferenceGuardVersion", 2), ("NessieExecutorIndependentRuntime", 1)] {
        let name = CString::new(name).map_err(|_| refused())?;
        let key = Owned::new(unsafe { CFStringCreateWithCString(std::ptr::null(), name.as_ptr(), UTF8) })?;
        let value = unsafe { CFDictionaryGetValue(dictionary, key.0) };
        if value.is_null() || unsafe { CFGetTypeID(value) != CFNumberGetTypeID() } { return Err(refused()); }
        let mut number = 0_i32;
        if unsafe { CFNumberGetValue(value, 3, (&mut number as *mut i32).cast()) } == 0 || number != expected {
            return Err(refused());
        }
    }
    Ok(())
}

struct Owned(Reference);
impl Owned {
    fn new(value: Reference) -> Result<Self, NativeError> {
        if value.is_null() { Err(refused()) } else { Ok(Self(value)) }
    }
}
impl Drop for Owned { fn drop(&mut self) { unsafe { CFRelease(self.0) } } }

fn requirement(team: &str) -> Result<Owned, NativeError> {
    if team.len() != 10 || !team.bytes().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit()) {
        return Err(refused());
    }
    // Developer ID Application's extension excludes Apple Development, App
    // Store distribution and ad-hoc signatures even from the same team.
    let text = CString::new(format!("anchor apple generic and certificate leaf[subject.OU] = \"{team}\" \
        and certificate leaf[field.1.2.840.113635.100.6.1.13] exists")).map_err(|_| refused())?;
    let text = Owned::new(unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), UTF8) })?;
    let mut result = std::ptr::null();
    if unsafe { SecRequirementCreateWithString(text.0, 0, &mut result) } != 0 { return Err(refused()); }
    Owned::new(result)
}

fn release_team() -> Result<&'static str, NativeError> {
    option_env!("NESSIE_DESKTOP_SIGNING_TEAM_ID").ok_or_else(refused)
}

pub fn require_current_release() -> Result<(), NativeError> {
    let requirement = requirement(release_team()?)?;
    let mut code = std::ptr::null();
    if unsafe { SecCodeCopySelf(0, &mut code) } != 0 { return Err(refused()); }
    let code = Owned::new(code)?;
    if unsafe { SecCodeCheckValidity(code.0, STRICT, requirement.0) } != 0 { return Err(refused()); }
    Ok(())
}

/// Validate the kernel-selected live process, not a newer file beside it.
pub fn require_process(pid: i32) -> Result<(), NativeError> {
    if pid <= 0 { return Err(refused()); }
    let requirement = requirement(release_team()?)?;
    let number = Owned::new(unsafe { CFNumberCreate(std::ptr::null(), 3, (&pid as *const i32).cast()) })?;
    let key = unsafe { kSecGuestAttributePid };
    let attributes = Owned::new(unsafe { CFDictionaryCreate(std::ptr::null(), &key, &number.0, 1,
        std::ptr::addr_of!(kCFTypeDictionaryKeyCallBacks), std::ptr::addr_of!(kCFTypeDictionaryValueCallBacks)) })?;
    let mut code = std::ptr::null();
    if unsafe { SecCodeCopyGuestWithAttributes(std::ptr::null(), attributes.0, 0, &mut code) } != 0 {
        return Err(refused());
    }
    let code = Owned::new(code)?;
    if unsafe { SecCodeCheckValidity(code.0, STRICT, requirement.0) } != 0 { return Err(refused()); }
    Ok(())
}

/// The native creator verifies each installed executable, never a supplied
/// "signed" boolean or a hash manifest by itself.
pub fn require_file(path: &Path) -> Result<(), NativeError> {
    require_current_release()?;
    let requirement = requirement(release_team()?)?;
    let code = static_file(path)?;
    if unsafe { SecStaticCodeCheckValidity(code.0, STRICT, requirement.0) } != 0 { return Err(refused()); }
    Ok(())
}

fn static_file(path: &Path) -> Result<Owned, NativeError> {
    if !path.is_absolute() { return Err(refused()); }
    let bytes = path.as_os_str().as_bytes();
    let url = Owned::new(unsafe { CFURLCreateFromFileSystemRepresentation(std::ptr::null(),
        bytes.as_ptr(), bytes.len() as isize, 0) })?;
    let mut code = std::ptr::null();
    if unsafe { SecStaticCodeCreateWithPath(url.0, 0, &mut code) } != 0 { return Err(refused()); }
    Owned::new(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsigned_test_process_and_forged_pins_never_grant_release_trust() {
        assert!(require_current_release().is_err());
        assert!(require_process(std::process::id() as i32).is_err());
        assert!(require_file(&std::env::current_exe().unwrap()).is_err());
        for team in ["", "adhoc", "lowercase1", "ABCDEFGHI\" or true"] {
            assert!(requirement(team).is_err());
        }
    }
}
