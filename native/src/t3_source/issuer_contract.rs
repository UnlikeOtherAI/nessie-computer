//! Closed signing vocabulary. This never accepts an arbitrary domain or key.
use super::{consent_contract::{identifier,uuid,now_ms,Recipient},handles::fail,resource::Resource};
use crate::protocol::NativeError;
use serde::{Deserialize,Serialize};
use serde_json::{Value,json};
use base64::{Engine,engine::general_purpose::{STANDARD,URL_SAFE_NO_PAD}};
use sha2::{Sha256,Digest};

#[derive(Clone,Deserialize,Serialize,PartialEq,Eq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Source {
    pub executor_id:String,pub environment_id:String,pub physical_root_key:String,pub admitted_root_key:String,
    pub database_identity:String,pub environment_identity:String,
}
impl Source {
    pub fn validate(&self)->Result<(),NativeError> {
        if !uuid(&self.executor_id) || ![&self.environment_id,&self.physical_root_key,&self.admitted_root_key,
            &self.database_identity,&self.environment_identity].iter().all(|s|identifier(s)) {return Err(fail());}
        Ok(())
    }
    pub fn from_resource(r:&Resource)->Result<Self,NativeError> {
        r.recheck()?;let d=&r.description;let s=&d["source"];
        let source:Self=serde_json::from_value(json!({"executorId":d["executorId"],"environmentId":s["environmentId"],
            "physicalRootKey":s["physicalRootKey"],"admittedRootKey":s["admittedRootKey"],
            "databaseIdentity":d["databaseIdentity"],"environmentIdentity":d["environmentIdentity"]})).map_err(|_|fail())?;
        source.validate()?;Ok(source)
    }
    pub fn from_value(v:&Value)->Result<Self,NativeError> {
        let mut source=serde_json::Map::new();
        for k in ["executorId","environmentId","physicalRootKey","admittedRootKey","databaseIdentity","environmentIdentity"] {
            source.insert(k.into(),v.get(k).ok_or_else(fail)?.clone());
        }
        let s:Self=serde_json::from_value(Value::Object(source)).map_err(|_|fail())?;s.validate()?;Ok(s)
    }
}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Enrollment {
    pub enrollment_id:String,pub nonce:String,pub executor_id:String,pub environment_id:String,
    pub physical_root_key:String,pub admitted_root_key:String,pub database_identity:String,pub environment_identity:String,
    pub recipient:Recipient,pub public_key:String,pub key_id:String,pub expires_at_ms:u64,
}
impl Enrollment {
    pub fn validate(&self)->Result<(),NativeError> {
        let now=now_ms()?;let bytes=STANDARD.decode(&self.public_key).map_err(|_|fail())?;
        let nonce=URL_SAFE_NO_PAD.decode(&self.nonce).map_err(|_|fail())?;
        // Ed25519 SPKI: exact algorithm OID, absent parameters, 32-byte public key.
        if bytes.len()!=44 || bytes[..12]!=[0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00]
            || STANDARD.encode(&bytes)!=self.public_key || format!("{:x}",Sha256::digest(&bytes))!=self.key_id
            || !uuid(&self.enrollment_id) || nonce.len()!=32 || URL_SAFE_NO_PAD.encode(nonce)!=self.nonce
            || self.expires_at_ms<=now || self.expires_at_ms>now+300_000
            || ![&self.recipient.subject,&self.recipient.organization_id,&self.recipient.team_id].iter().all(|s|identifier(s)) {
            return Err(fail());
        }
        Source::from_value(&serde_json::to_value(self).map_err(|_|fail())?)?;Ok(())
    }
}
/// Matches canonicalExecutorJson. Wire object keys are ASCII; UTF-16 ordering
/// is retained for completeness. Numbers in this vocabulary are safe integers.
pub fn canonical(v:&Value)->Result<String,NativeError> {
    Ok(match v {
        Value::Object(o)=>{
            let mut keys=o.keys().collect::<Vec<_>>();keys.sort_by_key(|k|k.encode_utf16().collect::<Vec<_>>());
            let mut entries=Vec::new();for k in keys {entries.push(format!("{}:{}",
                serde_json::to_string(k).map_err(|_|fail())?,canonical(&o[k])?));}
            format!("{{{}}}",entries.join(","))
        },
        Value::Array(a)=>format!("[{}]",a.iter().map(canonical).collect::<Result<Vec<_>,_>>()?.join(",")),
        Value::Number(n) if n.as_u64().is_none_or(|n|n>9_007_199_254_740_991)=>return Err(fail()),
        _=>serde_json::to_string(v).map_err(|_|fail())?,
    })
}
pub fn signing_bytes(domain:&str,payload:&Value)->Result<Vec<u8>,NativeError> {
    Ok(canonical(&json!({"domain":domain,"payload":payload}))?.into_bytes())
}
