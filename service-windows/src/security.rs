//! Who may talk to the control pipe, and how the service learns who did.
//!
//! The pipe's DACL admits the local **Administrators** group and every account
//! recorded under the service root — an elevated grant writes one before the
//! first pairing, and pairing records the account that performed it. Nothing
//! else is admitted: the pipe carries pairing challenges and executor controls,
//! so "anyone logged in" would be a different product.
//!
//! `PIPE_REJECT_REMOTE_CLIENTS` is set as well, because a DACL alone would still
//! let a domain account reach this pipe over the network.

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;

use windows_sys::Win32::Foundation::{
    CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE, HLOCAL, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSidToSidW, SetEntriesInAclW, EXPLICIT_ACCESS_W, NO_MULTIPLE_TRUSTEE, SET_ACCESS,
    TRUSTEE_IS_GROUP, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    CheckTokenMembership, CopySid, CreateWellKnownSid, GetLengthSid, GetTokenInformation,
    InitializeSecurityDescriptor, IsValidSid, RevertToSelf, SetSecurityDescriptorDacl, TokenUser,
    WinBuiltinAdministratorsSid, ACL, NO_INHERITANCE, PSECURITY_DESCRIPTOR, PSID,
    SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, SECURITY_MAX_SID_SIZE, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Pipes::ImpersonateNamedPipeClient;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken,
};

use nessie_windows_common::{is_sid_string, sid_to_string, CONTROL_PIPE_CLIENT_ACCESS};

/// What an admitted client may do: read the answer, write the request, and wait
/// on the handle. Deliberately **not** `FILE_GENERIC_WRITE`, whose
/// `FILE_APPEND_DATA` bit means `FILE_CREATE_PIPE_INSTANCE` on a pipe — that
/// would let an admitted account stand up a rival instance of this pipe and
/// answer for the service.
pub(crate) const CLIENT_ACCESS: u32 = CONTROL_PIPE_CLIENT_ACCESS;

// This ACE is for the service process only. `CreateNamedPipeW` asks for a
// server handle, including `FILE_CREATE_PIPE_INSTANCE`; mirroring client
// rights here would prevent the second instance from being created.
const SERVER_ACCESS: u32 = windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;

/// A SID copied out of the buffer that produced it, so the buffer's life stops
/// mattering to every later use.
pub struct OwnedSid(Vec<u8>);

impl OwnedSid {
    pub fn pointer(&self) -> PSID {
        self.0.as_ptr() as PSID
    }
}

fn copy_sid(source: PSID) -> Option<OwnedSid> {
    if source.is_null() || unsafe { IsValidSid(source) } == 0 {
        return None;
    }
    let length = unsafe { GetLengthSid(source) } as usize;
    let mut bytes = vec![0_u8; length];
    if unsafe { CopySid(length as u32, bytes.as_mut_ptr() as PSID, source) } == 0 {
        return None;
    }
    Some(OwnedSid(bytes))
}

fn sid_from_string(value: &str) -> Option<OwnedSid> {
    // The string form is validated before Win32 ever sees it: this list is read
    // from file names, and a name is not a capability.
    if !is_sid_string(value) {
        return None;
    }
    let wide: Vec<u16> = std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut sid: PSID = std::ptr::null_mut();
    if unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) } == 0 {
        return None;
    }
    let owned = copy_sid(sid);
    unsafe { LocalFree(sid as HLOCAL) };
    owned
}

fn token_user_sid(token: HANDLE) -> Option<OwnedSid> {
    let mut needed = 0_u32;
    unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
    let mut buffer = vec![0_u8; needed.max(1) as usize];
    let read = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
            &mut needed,
        )
    };
    if read == 0 {
        return None;
    }
    copy_sid(unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid })
}

/// The account this process runs as, in its string form. The elevated grant
/// records this so the person's own tray is admitted afterwards without
/// elevation.
pub fn current_user_sid_string() -> Result<String, String> {
    let mut token: HANDLE = INVALID_HANDLE_VALUE;
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err("Windows would not report this account.".to_owned());
    }
    let sid = token_user_sid(token);
    unsafe { CloseHandle(token) };
    sid.and_then(|sid| sid_to_string(sid.pointer()))
        .ok_or_else(|| "Windows would not report this account.".to_owned())
}

/// The authenticated identity on the other end of a control connection. The
/// DACL is the first gate; the administrator bit is deliberately read from the
/// impersonated token as the second gate for the one command that expands pipe
/// access.
pub struct ConnectedClient {
    pub is_administrator: bool,
    pub sid: String,
}

pub fn connected_client_identity(pipe: HANDLE) -> Option<ConnectedClient> {
    if unsafe { ImpersonateNamedPipeClient(pipe) } == 0 {
        return None;
    }
    let mut token: HANDLE = INVALID_HANDLE_VALUE;
    let opened = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) } != 0;
    let identity = if opened {
        let sid = token_user_sid(token);
        let administrators = well_known_administrators();
        let mut member = 0_i32;
        let is_administrator = administrators.as_ref().is_some_and(
            |group| unsafe { CheckTokenMembership(token, group.pointer(), &mut member) } != 0,
        ) && member != 0;
        unsafe { CloseHandle(token) };
        sid.and_then(|sid| sid_to_string(sid.pointer()))
            .map(|sid| ConnectedClient {
                sid,
                is_administrator,
            })
    } else {
        None
    };
    // Impersonation is never left in place: everything after this — spawning the
    // daemon, writing state — must happen as the service account.
    unsafe { RevertToSelf() };
    identity
}

fn well_known_administrators() -> Option<OwnedSid> {
    let mut bytes = vec![0_u8; SECURITY_MAX_SID_SIZE as usize];
    let mut size = SECURITY_MAX_SID_SIZE;
    let created = unsafe {
        CreateWellKnownSid(
            WinBuiltinAdministratorsSid,
            std::ptr::null_mut(),
            bytes.as_mut_ptr() as PSID,
            &mut size,
        )
    };
    if created == 0 {
        return None;
    }
    bytes.truncate(size as usize);
    Some(OwnedSid(bytes))
}

fn allow(sid: PSID, trustee_type: i32, access: u32) -> EXPLICIT_ACCESS_W {
    EXPLICIT_ACCESS_W {
        grfAccessPermissions: access,
        grfAccessMode: SET_ACCESS,
        grfInheritance: NO_INHERITANCE,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: trustee_type,
            ptstrName: sid as *mut u16,
        },
    }
}

/// The security descriptor for one pipe instance, and the ACL it points at.
/// Both have to outlive the `CreateNamedPipeW` call, which is why they are one
/// owned value rather than two temporaries.
pub struct PipeSecurity {
    acl: *mut ACL,
    descriptor: Box<SECURITY_DESCRIPTOR>,
}

impl PipeSecurity {
    /// Administrators plus every recorded account. An empty recorded list is not
    /// an error and not a widening: until an elevated grant records the first
    /// account, only an administrator can reach the pipe.
    pub fn new(recorded_sids: &[String], service_sid: &str) -> Result<Self, String> {
        Self::with_clients(recorded_sids, service_sid, false)
    }

    /// Runtime admission accepts local authenticated accounts, with every
    /// operation still checked against the signed launcher and kernel custody.
    pub fn custody(service_sid: &str) -> Result<Self, String> {
        Self::with_clients(&[], service_sid, true)
    }

    fn with_clients(
        recorded_sids: &[String],
        service_sid: &str,
        custody: bool,
    ) -> Result<Self, String> {
        let administrators = well_known_administrators()
            .ok_or_else(|| "Windows would not report the Administrators group.".to_owned())?;
        let service = sid_from_string(service_sid)
            .ok_or_else(|| "Windows would not report the Nessie Computer account.".to_owned())?;
        // The service is added below with its server rights. A malformed or
        // stale marker naming it must not add a second limited `SET_ACCESS`
        // entry and take `FILE_CREATE_PIPE_INSTANCE` back away.
        let recorded: Vec<OwnedSid> = recorded_sids
            .iter()
            .filter(|value| value.as_str() != service_sid)
            .filter_map(|value| sid_from_string(value))
            .collect();
        let authenticated = sid_from_string("S-1-5-11")
            .ok_or_else(|| "Windows would not report authenticated users.".to_owned())?;
        let mut entries = vec![allow(
            administrators.pointer(),
            TRUSTEE_IS_GROUP,
            CLIENT_ACCESS,
        )];
        if custody {
            entries.push(allow(
                authenticated.pointer(),
                TRUSTEE_IS_GROUP,
                CLIENT_ACCESS,
            ));
        }
        entries.extend(
            recorded
                .iter()
                .map(|sid| allow(sid.pointer(), TRUSTEE_IS_USER, CLIENT_ACCESS)),
        );
        entries.push(allow(service.pointer(), TRUSTEE_IS_USER, SERVER_ACCESS));
        let mut acl: *mut ACL = std::ptr::null_mut();
        let built = unsafe {
            SetEntriesInAclW(
                entries.len() as u32,
                entries.as_ptr(),
                std::ptr::null(),
                &mut acl,
            )
        };
        if built != ERROR_SUCCESS || acl.is_null() {
            return Err("Nessie Computer could not secure its control channel.".to_owned());
        }
        let mut descriptor: Box<SECURITY_DESCRIPTOR> = Box::new(unsafe { std::mem::zeroed() });
        let descriptor_pointer =
            descriptor.as_mut() as *mut SECURITY_DESCRIPTOR as PSECURITY_DESCRIPTOR;
        // SECURITY_DESCRIPTOR_REVISION is 1 and is what every absolute
        // descriptor is initialized with.
        let initialized = unsafe { InitializeSecurityDescriptor(descriptor_pointer, 1) } != 0
            && unsafe { SetSecurityDescriptorDacl(descriptor_pointer, 1, acl, 0) } != 0;
        if !initialized {
            unsafe { LocalFree(acl as HLOCAL) };
            return Err("Nessie Computer could not secure its control channel.".to_owned());
        }
        Ok(Self { acl, descriptor })
    }

    /// Borrowed for the lifetime of `self`; the caller passes it straight to
    /// `CreateNamedPipeW` and never stores it.
    pub fn attributes(&mut self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor.as_mut() as *mut SECURITY_DESCRIPTOR
                as *mut c_void,
            bInheritHandle: 0,
        }
    }
}

impl Drop for PipeSecurity {
    fn drop(&mut self) {
        if !self.acl.is_null() {
            unsafe { LocalFree(self.acl as HLOCAL) };
        }
    }
}

#[cfg(test)]
mod tests {
    use windows_sys::Win32::Storage::FileSystem::FILE_APPEND_DATA;

    use super::CLIENT_ACCESS;

    #[test]
    fn a_control_client_cannot_create_a_rival_pipe_instance() {
        assert_eq!(CLIENT_ACCESS & FILE_APPEND_DATA, 0);
    }
}

#[cfg(test)]
mod custody_tests {
    use super::*;
    use windows_sys::Win32::Security::{
        Authorization::GetEffectiveRightsFromAclW, GetSecurityDescriptorDacl,
    };
    fn rights(security: &mut PipeSecurity, sid: &str) -> u32 {
        let sid = sid_from_string(sid).unwrap();
        let entry = allow(sid.pointer(), TRUSTEE_IS_GROUP, 0);
        let (mut present, mut defaulted, mut acl) = (0, 0, std::ptr::null_mut());
        assert_ne!(
            unsafe {
                GetSecurityDescriptorDacl(
                    security.attributes().lpSecurityDescriptor,
                    &mut present,
                    &mut acl,
                    &mut defaulted,
                )
            },
            0
        );
        assert_ne!(present, 0);
        assert!(!acl.is_null());
        let mut rights = 0;
        assert_eq!(
            unsafe { GetEffectiveRightsFromAclW(acl, &entry.Trustee, &mut rights) },
            0
        );
        rights
    }
    #[test]
    fn authenticated_runtime_clients_gain_no_pairing_or_pipe_creation_rights() {
        let service = "S-1-5-21-1004336348-1177238915-682003330-1002";
        let mut control = PipeSecurity::new(&[], service).unwrap();
        let mut custody = PipeSecurity::custody(service).unwrap();
        assert_eq!(rights(&mut control, "S-1-5-11"), 0);
        assert_eq!(rights(&mut custody, "S-1-5-11"), CLIENT_ACCESS);
        assert_eq!(rights(&mut custody, service), SERVER_ACCESS);
        assert_eq!(rights(&mut custody, "S-1-5-7"), 0);
        assert_eq!(
            CLIENT_ACCESS & 4,
            0,
            "clients cannot create rival pipe instances"
        );
    }
}
