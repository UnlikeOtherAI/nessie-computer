//! Fresh source-owner authentication on the Windows secure desktop. No boolean,
//! environment flag or callback can create an AffirmedOwner.
use super::handles::fail;
use crate::protocol::NativeError;
use std::ffi::c_void;
use windows_sys::Win32::{Foundation::{CloseHandle, HANDLE}, Security::{
    GetTokenInformation, TokenUser, TOKEN_USER,
}};

#[repr(C)]
struct CredUiInfo { size: u32, parent: HANDLE, message: *const u16, caption: *const u16, banner: HANDLE }
#[link(name = "credui")]
extern "system" {
    fn CredUIPromptForWindowsCredentialsW(info: *const CredUiInfo, error: u32, package: *mut u32,
        input: *const c_void, input_size: u32, output: *mut *mut c_void, output_size: *mut u32,
        save: *mut i32, flags: u32) -> u32;
    fn CredUnPackAuthenticationBufferW(flags: u32, input: *const c_void, input_size: u32,
        user: *mut u16, user_size: *mut u32, domain: *mut u16, domain_size: *mut u32,
        password: *mut u16, password_size: *mut u32) -> i32;
}
#[link(name = "advapi32")]
extern "system" {
    fn LogonUserW(user: *const u16, domain: *const u16, password: *const u16,
        kind: u32, provider: u32, token: *mut HANDLE) -> i32;
}
#[link(name = "ole32")]
extern "system" { fn CoTaskMemFree(memory: *mut c_void); }
struct Packed { pointer: *mut c_void, length: u32 }
impl Drop for Packed {
    fn drop(&mut self) {
        if !self.pointer.is_null() {
            for i in 0..self.length as usize { unsafe { self.pointer.cast::<u8>().add(i).write_volatile(0); } }
            unsafe { CoTaskMemFree(self.pointer); }
        }
    }
}
struct Secret(Vec<u16>);
impl Drop for Secret { fn drop(&mut self) { for unit in &mut self.0 { unsafe { std::ptr::write_volatile(unit, 0); } } } }
pub struct AffirmedOwner { _private: () }

pub fn affirm(caption: String, message: String) -> Result<AffirmedOwner, NativeError> {
    let own = nessie_windows_common::process::Process::open(std::process::id()).map_err(|_| fail())?;
    nessie_windows_common::process::interactive(&own).map_err(|_| fail())?;
    let message: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
    if message.len() > 32_767 { return Err(fail()); }
    let caption: Vec<u16> = caption.encode_utf16().chain(Some(0)).collect();
    let info = CredUiInfo { size: std::mem::size_of::<CredUiInfo>() as u32, parent: std::ptr::null_mut(),
        message: message.as_ptr(), caption: caption.as_ptr(), banner: std::ptr::null_mut() };
    let mut package = 0; let mut save = 0;
    let mut packed = Packed { pointer: std::ptr::null_mut(), length: 0 };
    // SECURE_PROMPT | ENUMERATE_CURRENT_USER. No save checkbox or credential persistence.
    let result = unsafe { CredUIPromptForWindowsCredentialsW(&info, 0, &mut package, std::ptr::null(), 0,
        &mut packed.pointer, &mut packed.length, &mut save, 0x1000 | 0x200) };
    if result != 0 || packed.pointer.is_null() || packed.length == 0 || packed.length > 65_536 { return Err(fail()); }
    let (mut users, mut domains, mut passwords) = (0,0,0);
    unsafe { CredUnPackAuthenticationBufferW(0,packed.pointer,packed.length,std::ptr::null_mut(),&mut users,
        std::ptr::null_mut(),&mut domains,std::ptr::null_mut(),&mut passwords); }
    if users == 0 || users > 4096 || domains == 0 || domains > 4096 || passwords == 0 || passwords > 4096 { return Err(fail()); }
    let mut user = Secret(vec![0; users as usize]); let mut domain = Secret(vec![0; domains as usize]);
    let mut password = Secret(vec![0; passwords as usize]);
    if unsafe { CredUnPackAuthenticationBufferW(0,packed.pointer,packed.length,user.0.as_mut_ptr(),&mut users,
        domain.0.as_mut_ptr(),&mut domains,password.0.as_mut_ptr(),&mut passwords) } == 0 { return Err(fail()); }
    let mut token = std::ptr::null_mut();
    let domain_pointer = if domain.0[0] == 0 { std::ptr::null() } else { domain.0.as_ptr() };
    if unsafe { LogonUserW(user.0.as_ptr(),domain_pointer,password.0.as_ptr(),2,0,&mut token) } == 0 { return Err(fail()); }
    let result = (|| {
        let mut length = 0;
        unsafe { GetTokenInformation(token,TokenUser,std::ptr::null_mut(),0,&mut length); }
        if length == 0 || length > 65_536 { return Err(fail()); }
        let mut bytes = vec![0_usize;(length as usize).div_ceil(std::mem::size_of::<usize>())];
        if unsafe { GetTokenInformation(token,TokenUser,bytes.as_mut_ptr().cast(),length,&mut length) } == 0 { return Err(fail()); }
        let sid = nessie_windows_common::sid_to_string(unsafe { (*bytes.as_ptr().cast::<TOKEN_USER>()).User.Sid })
            .ok_or_else(fail)?;
        if sid != own.sid { return Err(fail()); }
        nessie_windows_common::process::interactive(&own).map_err(|_| fail())?;
        Ok(AffirmedOwner { _private: () })
    })();
    unsafe { CloseHandle(token); }
    result
}
