//! Only the service-created ceremony child receives this channel's input.
use super::{handles::fail,issuer_wire::{self,Reader},consent_contract::hex_id};
use crate::protocol::NativeError;
use serde_json::{Value,json};
use std::{fs::File,time::{Instant,Duration},sync::Mutex};
pub struct Issuer { pipe:Mutex<File> }
impl Issuer {
    pub fn open(nonce:&str)->Result<(Self,Value),NativeError> {
        if !hex_id(nonce) {return Err(fail());}
        let mut pipe=issuer_wire::client(&format!(r"\\.\pipe\NessieT3Ceremony-{nonce}"))?;
        let input=Reader::new().read(&mut pipe,Instant::now()+Duration::from_secs(5))?;
        Ok((Self {pipe:Mutex::new(pipe)},input))
    }
    pub fn recheck(&self)->Result<(),NativeError> {
        let pipe=self.pipe.lock().map_err(|_|fail())?;
        if issuer_wire::alive(&pipe) {Ok(())}else {Err(fail())}
    }
    pub fn call(&self,operation:&str,payload:Value)->Result<Value,NativeError> {
        let mut pipe=self.pipe.lock().map_err(|_|fail())?;
        issuer_wire::write(&mut pipe,&json!({"operation":operation,"payload":payload}))?;
        let reply=Reader::new().read(&mut pipe,Instant::now()+Duration::from_secs(5))?;
        if reply["ok"]!=true {return Err(fail());}Ok(reply["value"].clone())
    }
    pub fn ready(&self,value:&Value)->Result<(),NativeError> {
        let mut pipe=self.pipe.lock().map_err(|_|fail())?;
        issuer_wire::write(&mut pipe,&json!({"operation":"ready","payload":value}))
    }
}
