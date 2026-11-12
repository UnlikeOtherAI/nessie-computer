//! The OS opens the fixed OpenAI login URL; OAuth bytes never enter argv.
use crate::protocol::NativeError;
use serde::Deserialize;
use std::io::Read;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request { url: String }
fn refused() -> NativeError { NativeError::new("EXECUTOR_CHATGPT_BROWSER_UNAVAILABLE") }
fn validate(bytes: &[u8]) -> Result<String, NativeError> {
    if bytes.len() > 132_096 { return Err(refused()); }
    let request: Request = serde_json::from_slice(bytes).map_err(|_| refused())?;
    let prefix = ["https://auth.openai.com/api/accounts/authorize?", "https://auth.openai.com/oauth/authorize?"]
        .into_iter().find(|prefix| request.url.starts_with(prefix)).ok_or_else(refused)?;
    if request.url.len() > 131_072
        || request.url.contains(['\0', '\r', '\n', '#'])
        || !request.url[prefix.len()..].split('&').any(|field| field == "response_type=code") {
        return Err(refused());
    }
    Ok(request.url)
}

pub fn open() -> Result<(), NativeError> {
    crate::personal_state_context::require_release()?;
    crate::personal_state_context::protected_root()?;
    let mut bytes = Vec::new(); std::io::stdin().take(132_097).read_to_end(&mut bytes).map_err(|_| refused())?;
    let url = validate(&bytes)?;
    platform_open(&url)?;
    println!("{}", serde_json::json!({"status":"verified","version":1}));
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform_open(url: &str) -> Result<(), NativeError> {
    use std::ffi::c_void;
    type Reference = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFURLCreateWithBytes(allocator: Reference, bytes: *const u8, length: isize,
            encoding: u32, base: Reference) -> Reference;
        fn CFRelease(value: Reference);
    }
    #[link(name = "CoreServices", kind = "framework")]
    extern "C" { fn LSOpenCFURLRef(url: Reference, launched: *mut Reference) -> i32; }
    let reference = unsafe { CFURLCreateWithBytes(std::ptr::null(), url.as_ptr(), url.len() as isize,
        0x0800_0100, std::ptr::null()) };
    if reference.is_null() { return Err(refused()); }
    let status = unsafe { LSOpenCFURLRef(reference, std::ptr::null_mut()) };
    unsafe { CFRelease(reference); }
    if status != 0 { return Err(refused()); }
    Ok(())
}
#[cfg(windows)]
fn platform_open(url: &str) -> Result<(), NativeError> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    let url = url.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let action = "open".encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    if unsafe { ShellExecuteW(std::ptr::null_mut(), action.as_ptr(), url.as_ptr(), std::ptr::null(),
        std::ptr::null(), 1) } as isize <= 32 { return Err(refused()); }
    Ok(())
}
#[cfg(not(any(windows, target_os = "macos")))]
fn platform_open(_url: &str) -> Result<(), NativeError> { Err(refused()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_cannot_open_other_origins_routes_or_actions() {
        assert!(validate(br#"{"url":"https://auth.openai.com/api/accounts/authorize?response_type=code&state=opaque"}"#).is_ok());
        assert!(validate(br#"{"url":"https://auth.openai.com/oauth/authorize?response_type=code&state=opaque"}"#).is_ok());
        for url in ["https://auth.openai.com.evil.test/api/accounts/authorize?response_type=code",
            "https://auth.openai.com/other?response_type=code", "https://auth.openai.com/api/accounts/authorize?response_type=token",
            "file:///private/secret", "https://auth.openai.com/api/accounts/authorize?response_type=code#fragment"] {
            assert!(validate(&serde_json::to_vec(&serde_json::json!({"url":url})).unwrap()).is_err());
        }
        assert!(validate(br#"{"url":"https://auth.openai.com/api/accounts/authorize?response_type=code","path":"other"}"#).is_err());
    }
}
