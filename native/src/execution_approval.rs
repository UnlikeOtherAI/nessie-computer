//! Execution enrollment uses the shared secure-desktop owner proof; no imported
//! authority or retained-import key is accepted here.
use crate::protocol::NativeError;
use nessie_windows_common::execution::{now_ms, Challenge, Descriptor};
#[link(name = "kernel32")]
extern "system" {
    fn GetUserDefaultLocaleName(name: *mut u16, count: i32) -> i32;
}
pub fn approve(challenge: &Challenge, descriptor: &Descriptor) -> Result<(), NativeError> {
    let fail = || NativeError::new("EXECUTOR_T3_EXECUTION_REFUSED");
    challenge
        .validate(now_ms().map_err(|_| fail())?)
        .map_err(|_| fail())?;
    let words: serde_json::Value =
        serde_json::from_str(include_str!("execution-enrollment-words.json"))
            .map_err(|_| fail())?;
    let mut locale = [0; 85];
    let size = unsafe { GetUserDefaultLocaleName(locale.as_mut_ptr(), 85) };
    let locale = if size > 1 {
        String::from_utf16_lossy(&locale[..size as usize - 1])
    } else {
        "en".into()
    };
    let language = locale.split('-').next().unwrap_or("en");
    let words = words.get(language).unwrap_or(&words["en"]);
    let exact = serde_json::to_string_pretty(
        &serde_json::json!({"challenge":challenge,"descriptor":descriptor}),
    )
    .map_err(|_| fail())?;
    // Escape bidi/invisible/non-ASCII values in the exact descriptor, not prompt text.
    let exact = exact
        .chars()
        .map(|c| {
            if c.is_ascii() {
                c.to_string()
            } else {
                format!("\\u{{{:x}}}", c as u32)
            }
        })
        .collect::<String>();
    let _owner = crate::owner_approval_windows::affirm(
        words["title"].as_str().ok_or_else(fail)?.into(),
        format!(
            "{}\n\n{}",
            words["message"].as_str().ok_or_else(fail)?,
            exact
        ),
    )?;
    challenge
        .validate(now_ms().map_err(|_| fail())?)
        .map_err(|_| fail())
}
