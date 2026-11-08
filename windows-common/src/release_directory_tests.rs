//! Real protected-directory handles must permit the owner/DACL read they enforce.
use super::pin_protected;
use std::{ffi::OsStr, os::windows::ffi::OsStrExt, path::Path};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::{
        Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SECURITY_ATTRIBUTES,
    },
    Storage::FileSystem::CreateDirectoryW,
};

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

// The Windows native CI runner and the installed verification task are elevated.
// An Administrators-owned namespace is the same trust boundary as Program Files.
fn protected_directory(path: &Path, public_write: bool) {
    let sddl = if public_write {
        "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;AU)"
    } else {
        "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;AU)(A;OICIIO;GA;;;CO)"
    };
    let mut descriptor = std::ptr::null_mut();
    assert_ne!(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(OsStr::new(sddl)).as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        },
        0
    );
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let created = unsafe { CreateDirectoryW(wide(path.as_os_str()).as_ptr(), &attributes) };
    let error = std::io::Error::last_os_error();
    unsafe { LocalFree(descriptor) };
    assert_ne!(
        created, 0,
        "protected directory fixture requires an elevated Windows token: {error}"
    );
}

#[test]
fn protected_directory_accepts_readonly_public_access_and_rejects_public_writes() {
    let root = tempfile::tempdir().unwrap();
    let safe = root.path().join("safe");
    protected_directory(&safe, false);
    assert!(
        pin_protected(&safe, true).is_ok(),
        "a protected directory must be able to read its DACL"
    );
    let writable = root.path().join("writable");
    protected_directory(&writable, true);
    assert!(
        pin_protected(&writable, true).is_err(),
        "READ_CONTROL must not relax the trusted-owner/write checks"
    );
}

#[test]
fn the_standard_program_files_dacl_is_verifiable() {
    let path = crate::update_admission::known_folder(
        &windows_sys::Win32::UI::Shell::FOLDERID_ProgramFiles,
    )
    .unwrap();
    assert!(
        pin_protected(&path, true).is_ok(),
        "Program Files has inherit-only creator-owner entries, not public write access to itself"
    );
}
