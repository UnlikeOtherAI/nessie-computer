//! The few registry strings this tray reads and writes: its own login entry,
//! the `nessie://` handler Nessie Desktop's installer registers, and the
//! notification identity toasts are shown under. One reader and one writer,
//! so the buffer handling and the "missing is not an error" rule are stated
//! once.

use windows_sys::Win32::System::Registry::{RegDeleteKeyValueW, RegSetKeyValueW, HKEY, REG_SZ};
pub use nessie_windows_common::registry::read_string;

const ERROR_FILE_NOT_FOUND: u32 = 2;

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

/// A null name addresses the key's default value.
fn name_pointer(name: Option<&[u16]>) -> *const u16 {
    name.map_or(std::ptr::null(), <[u16]>::as_ptr)
}

/// Writes one `REG_SZ` value, creating the key when it is missing.
pub fn write_string(root: HKEY, key: &str, name: Option<&str>, value: &str) -> Result<(), u32> {
    let key = wide(key);
    let name = name.map(wide);
    let value = wide(value);
    let status = unsafe {
        RegSetKeyValueW(root, key.as_ptr(), name_pointer(name.as_deref()), REG_SZ,
            value.as_ptr().cast(), (value.len() * 2) as u32)
    };
    if status == 0 { Ok(()) } else { Err(status) }
}

/// Deletes one value. A value that is already gone is the requested state.
pub fn delete_value(root: HKEY, key: &str, name: &str) -> Result<(), u32> {
    let key = wide(key);
    let name = wide(name);
    let status = unsafe { RegDeleteKeyValueW(root, key.as_ptr(), name.as_ptr()) };
    if status == 0 || status == ERROR_FILE_NOT_FOUND { Ok(()) } else { Err(status) }
}
