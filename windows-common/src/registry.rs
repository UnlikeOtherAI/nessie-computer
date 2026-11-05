//! Bounded registry string reads shared by the tray and installed custody floor.
use windows_sys::Win32::System::Registry::{
    RegGetValueW, HKEY, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
};

const MISSING: u32 = 2;
const INVALID: u32 = 13;
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn decode(mut buffer: Vec<u16>, bytes: u32) -> Result<String, u32> {
    if bytes < 2 || bytes % 2 != 0 || bytes as usize > buffer.len() * 2 {
        return Err(INVALID);
    }
    buffer.truncate(bytes as usize / 2);
    if buffer.pop() != Some(0) || buffer.contains(&0) {
        return Err(INVALID);
    }
    String::from_utf16(&buffer).map_err(|_| INVALID)
}
pub fn read_string(root: HKEY, key: &str, name: Option<&str>) -> Result<Option<String>, u32> {
    read(root, key, name, RRF_RT_REG_SZ)
}
/// Read raw launch registration bytes in a selected registry view. Expansion is
/// never delegated to an untrusted caller environment.
pub(crate) fn read_launch_string(
    root: HKEY,
    key: &str,
    name: Option<&str>,
    view: u32,
) -> Result<Option<String>, u32> {
    read(
        root,
        key,
        name,
        RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND | view,
    )
}
fn read(root: HKEY, key: &str, name: Option<&str>, flags: u32) -> Result<Option<String>, u32> {
    let key = wide(key);
    let name = name.map(wide);
    let name = name.as_ref().map_or(std::ptr::null(), |name| name.as_ptr());
    let mut size = 0;
    let status = unsafe {
        RegGetValueW(
            root,
            key.as_ptr(),
            name,
            flags,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if status == MISSING {
        return Ok(None);
    }
    if status != 0 {
        return Err(status);
    }
    if size < 2 || size > 65_536 || size % 2 != 0 {
        return Err(INVALID);
    }
    let mut buffer = vec![0_u16; size as usize / 2];
    let status = unsafe {
        RegGetValueW(
            root,
            key.as_ptr(),
            name,
            flags,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    // A disappearing/changing value is not positive installed absence.
    if status != 0 {
        return Err(status);
    }
    decode(buffer, size).map(Some)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registry_strings_are_bounded_exact_utf16_not_lossy_prefixes() {
        assert_eq!(decode(vec![65, 0], 4).unwrap(), "A");
        for (buffer, bytes) in [
            (vec![65, 0], 5),
            (vec![65], 2),
            (vec![65, 0, 66, 0], 8),
            (vec![0xd800, 0], 4),
        ] {
            assert!(decode(buffer, bytes).is_err());
        }
    }
}
