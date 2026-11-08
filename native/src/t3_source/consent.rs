use super::{consent_auth,consent_contract::{Challenge,now_ms,uuid},consent_peer::Context,
    consent_pipe,consent_state::Consent,handles::fail,lease::LeaseClock,resource::Resource,
    issuer_client::Issuer,issuer_contract::{Enrollment,Source}};
use crate::protocol::NativeError;
use std::{io::{Read,Write},sync::{Arc,mpsc,atomic::AtomicBool},time::{Duration,Instant}};
use serde_json::Value;

fn watchdog(seconds:u64) {
    std::thread::spawn(move || {std::thread::sleep(Duration::from_secs(seconds));std::process::exit(1);});
}
fn resource(input:&Value)->Result<Resource,NativeError> {
    let executor=input["executorId"].as_str().ok_or_else(fail)?;
    let key=input["admittedRootKey"].as_str().ok_or_else(fail)?;
    if !uuid(executor) || key.is_empty() || key.len()>128
        || !key.bytes().all(|c|c.is_ascii_alphanumeric() || c==b'_' || c==b'-') {return Err(fail());}
    let root=crate::personal_state_context::protected_root()?;
    let home=root.parent().and_then(|p|p.parent()).ok_or_else(fail)?;
    let state=home.join(".local/state/nessie-executor").join(executor);
    let request=Resource::configured_request(&state,executor,key)?;
    Resource::open_with_clock(&request,Arc::new(LeaseClock::new()))
}
/// The broker created this exact protected user process and holds its lifetime.
/// A daemon cannot call an approval CLI with a boolean, key, or borrowed receipt.
pub fn approve(nonce:&str) -> Result<(),NativeError> {
    watchdog(300);
    let context=Context::open(true)?;
    let (issuer,input)=Issuer::open(nonce)?;let issuer=Arc::new(issuer);
    let kind=input["kind"].as_str().ok_or_else(fail)?;let input=&input["input"];
    let resource=resource(input)?;let source=Source::from_resource(&resource)?;
    let offer=issuer.call("bind",serde_json::to_value(&source).map_err(|_|fail())?)?;
    let output=match kind {
        "offer"=>offer,
        "enroll"=>{
            let enrollment:Enrollment=serde_json::from_value(input.clone()).map_err(|_|fail())?;
            enrollment.validate()?;
            if Source::from_value(input)?!=source || input["publicKey"]!=offer["publicKey"]
                || input["keyId"]!=offer["keyId"] {return Err(fail());}
            let _owner=affirm(&context,&resource,&issuer,input,"enroll",enrollment.expires_at_ms)?;
            resource.recheck()?;issuer.call("enroll",input.clone())?
        },
        "approve"=>{
            let challenge:Challenge=serde_json::from_value(input.clone()).map_err(|_|fail())?;
            challenge.bind(&resource)?;
            if input["issuerKeyId"]!=offer["keyId"] {return Err(fail());}
            let owner=affirm(&context,&resource,&issuer,input,"approve",challenge.grant_expires_at_ms)?;
            challenge.bind(&resource)?;context.recheck()?;issuer.recheck()?;
            let consent=Consent::issue(challenge,owner,issuer.clone())?;
            return consent_pipe::serve(&context,resource,consent,Arc::new(AtomicBool::new(false)),issuer);
        },
        _=>return Err(fail()),
    };
    resource.recheck()?;context.recheck()?;issuer.recheck()?;issuer.ready(&output)?;
    // Keep the output and source alive until the tray has received it and closes.
    loop {issuer.recheck()?;context.recheck()?;resource.recheck()?;resource.renew()?;
        std::thread::sleep(Duration::from_millis(50));}
}
fn affirm(context:&Context,resource:&Resource,issuer:&Issuer,input:&Value,kind:&str,expiry:u64)
    ->Result<consent_auth::AffirmedOwner,NativeError> {
    let lifetime=expiry.checked_sub(now_ms()?).ok_or_else(fail)?;let opened=Instant::now();
    let (send,receive)=mpsc::sync_channel(1);
    let (caption,message)=super::consent_words::prompt(input,kind)?;
    std::thread::spawn(move || {let _=send.send(consent_auth::affirm(caption,message));});
    loop {
        context.recheck()?;resource.recheck()?;resource.renew()?;issuer.recheck()?;
        if now_ms()?>=expiry || opened.elapsed().as_millis()>=lifetime as u128 {return Err(fail());}
        match receive.recv_timeout(Duration::from_millis(50)) {
            Ok(result)=>return result, Err(mpsc::RecvTimeoutError::Timeout)=>{},Err(_)=>return Err(fail()),
        }
    }
}
pub fn verify() -> Result<(),NativeError> {
    watchdog(15);
    let context=Context::open(false)?;
    let mut bytes=Vec::new();std::io::stdin().take(65_537).read_to_end(&mut bytes).map_err(|_|fail())?;
    if bytes.len()>65_536 {return Err(fail());}
    let request:Value=serde_json::from_slice(&bytes).map_err(|_|fail())?;
    let challenge:Challenge=serde_json::from_value(request["challenge"].clone()).map_err(|_|fail())?;
    challenge.validate(now_ms()?)?;
    let response=consent_pipe::verify(&context,&request)?;
    challenge.validate(now_ms()?)?;
    println!("{response}");std::io::stdout().flush().map_err(|_|fail())
}
