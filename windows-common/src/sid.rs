//! Rendering a SID as the string both binaries exchange.
//!
//! `ConvertSidToStringSidW` allocates with `LocalAlloc`, so the caller frees it;
//! the result is validated before it is returned, because it becomes a file name
//! under the service root and is later converted back for the control pipe's
//! DACL. A name is not a capability.

use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::PSID;

use crate::is_sid_string;

/// The string form of a SID, or `None` when Windows would not render one or
/// rendered something this crate would refuse to read back.
///
/// `sid` must point at a valid SID that outlives the call.
pub fn sid_to_string(sid: PSID) -> Option<String> {
    let mut text: *mut u16 = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 || text.is_null() {
        return None;
    }
    let mut length = 0_usize;
    while unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    let value = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) }).ok();
    unsafe { LocalFree(text as HLOCAL) };
    value.filter(|candidate| is_sid_string(candidate))
}
