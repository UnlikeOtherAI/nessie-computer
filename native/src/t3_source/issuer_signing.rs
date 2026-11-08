//! Sign only typed messages from the broker's retained ceremony child.
use super::{handles::fail,issuer_store::Key,issuer_contract::{Source,Enrollment},consent_contract::{Challenge,Verification,now_ms}};
use crate::protocol::NativeError;
use serde_json::{Value,json};

pub struct SigningSession {kind:String,input:Value,source:Option<Source>,key:Option<Key>,receipt:Option<Value>}
impl SigningSession {
    pub fn new(kind:String,input:Value)->Result<Self,NativeError> {
        if !["offer","enroll","approve"].contains(&kind.as_str()) {return Err(fail());}
        Ok(Self {kind,input,source:None,key:None,receipt:None})
    }
    pub fn dispatch(&mut self,sid:&str,operation:&str,payload:Value)->Result<Value,NativeError> {
        if operation=="bind" {
            if self.source.is_some() {return Err(fail());}
            let source:Source=serde_json::from_value(payload).map_err(|_|fail())?;source.validate()?;
            if self.kind=="offer" {
                if self.input.as_object().is_none_or(|o|o.len()!=2) || self.input["executorId"]!=source.executor_id
                    || self.input["admittedRootKey"]!=source.admitted_root_key {return Err(fail());}
            } else if Source::from_value(&self.input)?!=source {return Err(fail());}
            let key=Key::open(&source,sid,self.kind=="offer")?;
            let mut value=serde_json::to_value(&source).map_err(|_|fail())?;
            value["publicKey"]=json!(key.public_key);value["keyId"]=json!(key.key_id);
            value["expiresAtMs"]=json!(now_ms()?+300_000);
            self.key=Some(key);self.source=Some(source);return Ok(value);
        }
        let key=self.key.as_ref().ok_or_else(fail)?;
        let source=self.source.as_ref().ok_or_else(fail)?;
        match operation {
            "enroll" if self.kind=="enroll"=>{
                let e:Enrollment=serde_json::from_value(payload.clone()).map_err(|_|fail())?;e.validate()?;
                if payload!=self.input || Source::from_value(&payload)?!=*source || e.public_key!=key.public_key
                    || e.key_id!=key.key_id || self.receipt.is_some() {return Err(fail());}
                let signature=key.sign("nessie.t3.retained-import.issuer-enrollment.v1",&payload)?;
                self.receipt=Some(payload);
                Ok(json!({"enrollmentId":e.enrollment_id,"keyId":key.key_id,"nativeSignature":signature}))
            },
            "approve" if self.kind=="approve"=>{
                let challenge:Challenge=serde_json::from_value(payload["challenge"].clone()).map_err(|_|fail())?;
                challenge.validate(now_ms()?)?;
                let r=&payload["receipt"];
                if payload["challenge"]!=self.input || challenge.issuer_key_id!=key.key_id || self.receipt.is_some()
                    || Source::from_value(&payload["challenge"])?!=*source
                    || r["issuerKeyId"]!=key.key_id || r["challengeDigest"]!=challenge.digest()?
                    || r["challengeId"]!=challenge.challenge_id || r["expiresAtMs"]!=challenge.expires_at_ms
                    || r["version"]!=1 || r["kind"]!="native-source-owner-consent"
                    || r.as_object().is_none_or(|o|o.len()!=8)
                    || !["receiptId","issuerInstance"].iter().all(|k|r[*k].as_str().is_some_and(super::consent_contract::hex_id)) {
                    return Err(fail());
                }
                let signature=key.sign("nessie.t3.retained-import.approval.v1",&payload)?;
                self.receipt=Some(r.clone());Ok(json!(signature))
            },
            "live" if self.kind=="approve"=>{
                let challenge:Challenge=serde_json::from_value(self.input.clone()).map_err(|_|fail())?;
                challenge.validate(now_ms()?)?;let r=self.receipt.as_ref().ok_or_else(fail)?;
                let v:Verification=serde_json::from_value(payload["verification"].clone()).map_err(|_|fail())?;
                v.validate(now_ms()?,challenge.grant_expires_at_ms)?;
                if payload.as_object().is_none_or(|o|o.len()!=10) || payload["version"]!=1
                    || !["consume","recheck","revoke"].iter().any(|s|payload["operation"]==*s)
                    || payload["issuerKeyId"]!=key.key_id || payload["receiptId"]!=r["receiptId"]
                    || payload["issuerInstance"]!=r["issuerInstance"] || payload["challengeDigest"]!=r["challengeDigest"]
                    || !payload["consumptionId"].as_str().is_some_and(super::consent_contract::hex_id)
                    || payload["expiresAtMs"]!=v.expires_at_ms
                    || payload["observedAtMs"].as_u64().is_none_or(|n|n<v.issued_at_ms || n>now_ms().unwrap_or(0)) {
                    return Err(fail());
                }
                Ok(json!(key.sign("nessie.t3.retained-import.live.v1",&payload)?))
            },
            _=>Err(fail()),
        }
    }
}
