//! Exact ECMAScript trim used by the pinned original Effect string codec.
use crate::custody::REJECTED;
use serde_json::Value;
pub(crate) fn trimmed(raw: &Value) -> Result<String, String> {
    let raw = raw.as_str().ok_or(REJECTED)?;
    let value = raw.trim_matches(|c| {
        matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}'
        | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
    });
    if value.is_empty() {
        return Err(REJECTED.into());
    }
    Ok(value.into())
}
