use super::handles::fail;
use crate::protocol::NativeError;
use serde_json::Value;

#[link(name="kernel32")]
extern "system" {fn GetUserDefaultLocaleName(name:*mut u16,count:i32)->i32;}
pub fn prompt(input:&Value,kind:&str)->Result<(String,String),NativeError> {
    let words:Value=serde_json::from_str(include_str!("../../../packages/executor-console/retained-import-words.json"))
        .map_err(|_|fail())?;
    let mut locale=[0;85];let size=unsafe {GetUserDefaultLocaleName(locale.as_mut_ptr(),85)};
    let language=if size>1 {String::from_utf16_lossy(&locale[..(size as usize-1)]).split('-').next().unwrap_or("en").to_owned()}
        else {"en".into()};
    let w=words.get(&language).unwrap_or(&words["en"]);
    let caption=w[if kind=="enroll" {"enroll"}else {"approve"}].as_str().ok_or_else(fail)?.to_owned();
    let pretty=serde_json::to_string_pretty(input).map_err(|_|fail())?;
    // Render directional/invisible/non-ASCII codepoints as explicit escapes.
    // IDs remain exact and cannot impersonate prompt labels with bidi text.
    let escaped=pretty.chars().map(|c|if c.is_ascii() {c.to_string()}else {format!("\\u{{{:x}}}",c as u32)}).collect::<String>();
    let message=format!("{}\n\n{}\n\n{}",w["ceremony"].as_str().ok_or_else(fail)?,
        w["baseline"].as_str().ok_or_else(fail)?,escaped);
    if message.encode_utf16().count()>32_766 {return Err(fail());}
    Ok((caption,message))
}
