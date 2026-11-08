//! Lossless CreateProcess argument/environment encoding; no shell is involved.
use nessie_windows_common::custody::REJECTED;
use std::collections::{BTreeMap, BTreeSet};
pub fn quote(value: &str) -> Result<String, String> {
    if value.contains('\0') {
        return Err(REJECTED.into());
    }
    let mut output = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        if ch == '"' {
            output.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
        } else {
            output.extend(std::iter::repeat_n('\\', slashes));
        }
        slashes = 0;
        output.push(ch);
    }
    output.extend(std::iter::repeat_n('\\', slashes * 2));
    output.push('"');
    Ok(output)
}
pub fn command(image: &str, args: &[String]) -> Result<Vec<u16>, String> {
    let mut values = vec![quote(image)?];
    for arg in args {
        values.push(quote(arg)?);
    }
    let text = values.join(" ");
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    if wide.len() >= 32767 {
        return Err(REJECTED.into());
    }
    wide.push(0);
    Ok(wide)
}
pub fn environment(values: &BTreeMap<String, String>) -> Result<Vec<u16>, String> {
    let mut names = BTreeSet::new();
    let mut sorted = Vec::new();
    for (key, value) in values {
        if key.is_empty()
            || key.contains(['=', '\0'])
            || value.contains('\0')
            || !names.insert(key.to_uppercase())
        {
            return Err(REJECTED.into());
        }
        sorted.push((key.to_uppercase(), format!("{key}={value}")));
    }
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut output = Vec::new();
    for (_, value) in sorted {
        output.extend(value.encode_utf16());
        output.push(0);
    }
    if output.is_empty() {
        output.push(0);
    }
    output.push(0);
    if output.len() > 32767 {
        return Err(REJECTED.into());
    }
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quotes_preserve_empty_quotes_and_trailing_slashes() {
        assert_eq!(quote("").unwrap(), "\"\"");
        assert_eq!(quote("a b").unwrap(), "\"a b\"");
        assert_eq!(quote("a\"b").unwrap(), "\"a\\\"b\"");
        assert_eq!(quote("C:\\home\\").unwrap(), "\"C:\\home\\\\\"");
        assert!(quote("bad\0arg").is_err());
    }
    #[test]
    fn environment_has_double_terminator_and_no_case_aliases() {
        let mut values = BTreeMap::from([("Path".into(), "one".into())]);
        let bytes = environment(&values).unwrap();
        assert!(bytes.ends_with(&[0, 0]));
        values.insert("PATH".into(), "two".into());
        assert!(environment(&values).is_err());
    }
}
