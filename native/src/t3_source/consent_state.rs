use super::{consent_auth::AffirmedOwner, consent_contract::{Challenge,Verification,now_ms},
    handles::fail, resource::hex,issuer_client::Issuer,issuer_contract::canonical};
use crate::protocol::NativeError;
use serde_json::{json, Value};
use std::{time::Instant,sync::Arc,collections::HashMap};
use sha2::{Digest,Sha256};

pub fn random_id() -> Result<String, NativeError> {
    let mut bytes = [0_u8;32];
    if unsafe { windows_sys::Win32::Security::Cryptography::BCryptGenRandom(std::ptr::null_mut(),
        bytes.as_mut_ptr(),bytes.len() as u32,2) } < 0 { return Err(fail()); }
    Ok(hex(&bytes))
}
pub struct Consent {
    pub challenge: Challenge,
    pub receipt: Value,
    consumption: Option<String>,
    revoked: bool,
    opened: Instant,
    milliseconds: u64,
    issuer:Arc<Issuer>,
    verifications:HashMap<String,(String,Value)>,
}
impl Consent {
    pub fn issue(challenge: Challenge, _affirmation: AffirmedOwner,issuer:Arc<Issuer>) -> Result<Self, NativeError> {
        let now = now_ms()?; challenge.validate(now)?;
        let mut receipt = json!({"version":1,"kind":"native-source-owner-consent","challengeId":challenge.challenge_id,
            "challengeDigest":challenge.digest()?,"receiptId":random_id()?,"issuerInstance":random_id()?,
            "expiresAtMs":challenge.expires_at_ms,"issuerKeyId":challenge.issuer_key_id});
        receipt["nativeSignature"]=issuer.call("approve",json!({"challenge":challenge,"receipt":receipt}))?;
        let milliseconds = challenge.grant_expires_at_ms - now;
        Ok(Self { challenge,receipt,consumption:None,revoked:false,opened:Instant::now(),milliseconds,
            issuer,verifications:HashMap::new() })
    }
    pub fn recheck(&self) -> Result<(), NativeError> {
        if self.revoked {return Err(fail());}
        self.transport_live()
    }
    /// A revoke response may drain, but never past its monotonic lease expiry.
    pub fn transport_live(&self)->Result<(),NativeError> {
        if self.opened.elapsed().as_millis() >= self.milliseconds as u128 { return Err(fail()); }
        self.issuer.recheck()?;self.challenge.validate(now_ms()?)
    }
    pub fn dispatch(&mut self, request: &Value) -> Result<Value, NativeError> {
        self.issuer.recheck()?;
        let challenge: Challenge = serde_json::from_value(request["challenge"].clone()).map_err(|_| fail())?;
        challenge.validate(now_ms()?)?;
        if challenge.digest()? != self.challenge.digest()? || request["receipt"] != self.receipt { return Err(fail()); }
        let operation=request["operation"].as_str().ok_or_else(fail)?;
        let expected=(if operation=="consume" {3}else {4})+usize::from(request.get("verification").is_some());
        if request.as_object().is_none_or(|o|o.len()!=expected) {return Err(fail());}
        let verification=request.get("verification").map(|v|serde_json::from_value::<Verification>(v.clone())
            .map_err(|_|fail())).transpose()?;
        let fingerprint=canonical(request)?;
        if let Some(v)=&verification {
            v.validate(now_ms()?,self.challenge.grant_expires_at_ms)?;
            if let Some((prior,result))=self.verifications.get(&v.verification_id) {
                if prior!=&fingerprint || (self.revoked && operation!="revoke") {return Err(fail());}
                if self.opened.elapsed().as_millis()>=self.milliseconds as u128 {return Err(fail());}
                return Ok(result.clone());
            }
            if self.verifications.len()>=256 {return Err(fail());}
        }
        self.recheck()?;
        let mut result=match operation {
            "consume" => {
                if self.consumption.is_some() || request.get("consumption").is_some() || verification.is_none() { return Err(fail()); }
                let consumption = random_id()?;
                self.consumption = Some(consumption.clone());
                json!({"consumption":consumption,"challengeDigest":self.challenge.digest()?})
            },
            "recheck" | "revoke" => {
                if self.consumption.as_deref() != request["consumption"].as_str() || self.consumption.is_none() { return Err(fail()); }
                if request["operation"] == "revoke" { self.revoked = true; }
                json!({"challengeDigest":self.challenge.digest()?})
            },
            _ => return Err(fail()),
        };
        if let Some(v)=verification {
            let mut proof=json!({"version":1,"operation":operation,"verification":v,
                "issuerKeyId":self.receipt["issuerKeyId"],"issuerInstance":self.receipt["issuerInstance"],
                "receiptId":self.receipt["receiptId"],"challengeDigest":self.challenge.digest()?,
                "consumptionId":hex(&Sha256::digest(self.consumption.as_ref().ok_or_else(fail)?.as_bytes())),
                "observedAtMs":now_ms()?,"expiresAtMs":v.expires_at_ms});
            proof["nativeSignature"]=self.issuer.call("live",proof.clone())?;
            result["proof"]=proof;
            self.verifications.insert(v.verification_id,(fingerprint,result.clone()));
        }
        Ok(result)
    }
}
