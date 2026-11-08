//! Product-only Ed25519 keys. Only SYSTEM can read the seed. No user/profile store.
use super::{handles::{fail,Held,namespace_chain,wide},issuer_contract::{Source,canonical,signing_bytes}};
use crate::protocol::NativeError;
use base64::{Engine,engine::general_purpose::STANDARD};
use ed25519_dalek::{SigningKey,Signer,pkcs8::EncodePublicKey};
use serde_json::{Value,json};
use sha2::{Sha256,Digest};
use std::{io::{Read,Write},fs::File,os::windows::io::{FromRawHandle,AsRawHandle}};
use windows_sys::Win32::{Foundation::{LocalFree,GetLastError,ERROR_ALREADY_EXISTS,INVALID_HANDLE_VALUE},
    Security::{SECURITY_ATTRIBUTES,Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW},
    Storage::FileSystem::{CreateDirectoryW,CreateFileW,CREATE_NEW,FILE_FLAG_OPEN_REPARSE_POINT}};

pub struct Key { key:SigningKey,pub public_key:String,pub key_id:String,_pins:Vec<Held> }
impl Key {
    /// Serialized by the broker. An incomplete/corrupt prior creation refuses;
    /// no key replacement, repair, default key or automatic re-enrollment.
    pub fn open(source:&Source,sid:&str,create:bool)->Result<Self,NativeError> {
        source.validate()?;
        let own=nessie_windows_common::process::Process::open(std::process::id()).map_err(|_|fail())?;
        if own.sid!="S-1-5-18" || own.session!=0 {return Err(fail());}
        let parent=nessie_windows_common::update_admission::root().map_err(|_|fail())?;
        let mut pins=namespace_chain(&parent)?;
        let parent=pins.last().ok_or_else(fail)?.path()?;
        let _protected=nessie_windows_common::release::pin_protected(&parent,true).map_err(|_|fail())?;
        let directory=parent.join("retained-import-issuers");
        let mut descriptor=std::ptr::null_mut();
        if unsafe {ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(std::path::Path::new("O:SYG:SYD:P(A;OICI;FA;;;SY)")).as_ptr(),1,
            &mut descriptor,std::ptr::null_mut())}==0 {return Err(fail());}
        let attributes=SECURITY_ATTRIBUTES {nLength:std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor:descriptor,bInheritHandle:0};
        let made=unsafe {CreateDirectoryW(wide(&directory).as_ptr(),&attributes)};
        let error=unsafe {GetLastError()};unsafe {LocalFree(descriptor);}
        if made==0 && error!=ERROR_ALREADY_EXISTS {return Err(fail());}
        pins.push(Held::open(&directory,true,false,true)?);
        let index=format!("{:x}",Sha256::digest(canonical(&json!({"source":source,"sourceOwnerSid":sid}))?.as_bytes()));
        let path=directory.join(format!("{index}.seed"));
        let mut seed=[0_u8;32];
        match Held::open(&path,false,false,true) {
            Ok(mut held)=>{
                if held.file.metadata().map_err(|_|fail())?.len()!=32 {return Err(fail());}
                held.file.read_exact(&mut seed).map_err(|_|fail())?;pins.push(held);
            },
            Err(_) if create=>{
                // CREATE_NEW cannot overwrite or adopt a race winner, reparse or corrupt file.
                let descriptor=crate::state_security::private_pipe_descriptor()?;
                let attributes=SECURITY_ATTRIBUTES {nLength:std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                    lpSecurityDescriptor:descriptor,bInheritHandle:0};
                let handle=unsafe {CreateFileW(wide(&path).as_ptr(),0x4000_0000|0x0002_0000,0,&attributes,
                    CREATE_NEW,FILE_FLAG_OPEN_REPARSE_POINT,std::ptr::null_mut())};
                unsafe {LocalFree(descriptor);}
                if handle==INVALID_HANDLE_VALUE {return Err(fail());}
                let mut file=unsafe {File::from_raw_handle(handle)};
                crate::state_security::verify_owner_only_handle(file.as_raw_handle())?;
                if unsafe {windows_sys::Win32::Security::Cryptography::BCryptGenRandom(std::ptr::null_mut(),
                    seed.as_mut_ptr(),32,2)}<0 {return Err(fail());}
                file.write_all(&seed).and_then(|()|file.sync_all()).map_err(|_|fail())?;drop(file);
                pins.push(Held::open(&path,false,false,true)?);
            },
            Err(e)=>return Err(e),
        }
        let key=SigningKey::from_bytes(&seed);
        for b in &mut seed {unsafe {std::ptr::write_volatile(b,0);}}
        let der=key.verifying_key().to_public_key_der().map_err(|_|fail())?;
        let key_id=format!("{:x}",Sha256::digest(der.as_bytes()));
        Ok(Self {key,public_key:STANDARD.encode(der.as_bytes()),key_id,_pins:pins})
    }
    pub fn sign(&self,domain:&str,payload:&Value)->Result<String,NativeError> {
        // Private to the source issuer modules; no IPC arbitrary-sign operation.
        self._pins.last().ok_or_else(fail)?.recheck()?;
        Ok(STANDARD.encode(self.key.sign(&signing_bytes(domain,payload)?).to_bytes()))
    }
}
