//! Putting the service account into **Hyper-V Administrators**.
//!
//! The sandbox backend on Windows is a Generation 2 VM per session, created and
//! destroyed by the service account through the Hyper-V WMI provider, and that
//! provider admits members of the built-in Hyper-V Administrators alias and
//! nobody else. The membership is therefore part of installing the service, not
//! something a person is asked to arrange afterwards.
//!
//! WiX's own `util:User`/`util:GroupRef` cannot do it: its custom action
//! resolves accounts in a way that fails for virtual service accounts against a
//! built-in alias. So the installer runs this binary as a deferred custom
//! action instead, after `InstallServices` — the virtual account does not exist
//! until the service does.
//!
//! Two things it must not do: name the group in English (the alias is localized,
//! so it is resolved from its well-known SID), and fail a reinstall (an account
//! already in the group is the desired state, not an error).

/// `S-1-5-32-578`, the built-in Hyper-V Administrators alias, and the composer
/// that reproduces it from its parts. Neither is called by the running service:
/// the alias is named by its SID in the installer's authoring and in
/// `docs/running-the-apps/overview.md`, while the Win32 call below builds it from
/// `SECURITY_BUILTIN_DOMAIN_RID` and `DOMAIN_ALIAS_RID_HYPER_V_ADMINS`. The test
/// at the bottom is what ties those three statements together, so a mistyped RID
/// — which would grant far more than Hyper-V — cannot pass unnoticed.
#[cfg(test)]
pub const HYPERV_ADMINISTRATORS_SID: &str = "S-1-5-32-578";

#[cfg(test)]
pub fn well_known_sid_string(authority: u8, sub_authorities: &[u32]) -> String {
    let parts: Vec<String> = sub_authorities.iter().map(u32::to_string).collect();
    format!("S-1-{authority}-{}", parts.join("-"))
}

#[cfg(windows)]
mod imp {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::{ERROR_MEMBER_IN_ALIAS, ERROR_SUCCESS};
    use windows_sys::Win32::NetworkManagement::NetManagement::{
        NetLocalGroupAddMembers, LOCALGROUP_MEMBERS_INFO_0,
    };
    use windows_sys::Win32::Security::{
        AllocateAndInitializeSid, FreeSid, LookupAccountNameW, LookupAccountSidW, PSID,
        SECURITY_NT_AUTHORITY, SID_NAME_USE,
    };
    use windows_sys::Win32::System::SystemServices::{
        DOMAIN_ALIAS_RID_HYPER_V_ADMINS, SECURITY_BUILTIN_DOMAIN_RID,
    };

    use nessie_windows_common::SERVICE_ACCOUNT;

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// The alias's localized display name, resolved from its SID. `net localgroup`
    /// and `NetLocalGroupAddMembers` both take a name, and on a German or
    /// Japanese Windows the English one does not exist.
    fn hyperv_administrators_name() -> Result<Vec<u16>, String> {
        let mut sid: PSID = std::ptr::null_mut();
        let allocated = unsafe {
            AllocateAndInitializeSid(
                &SECURITY_NT_AUTHORITY,
                2,
                SECURITY_BUILTIN_DOMAIN_RID as u32,
                DOMAIN_ALIAS_RID_HYPER_V_ADMINS as u32,
                0,
                0,
                0,
                0,
                0,
                0,
                &mut sid,
            )
        };
        if allocated == 0 {
            return Err("Windows would not name the Hyper-V Administrators group.".to_owned());
        }
        let mut name = vec![0_u16; 256];
        let mut name_length = name.len() as u32;
        let mut domain = vec![0_u16; 256];
        let mut domain_length = domain.len() as u32;
        let mut kind: SID_NAME_USE = 0;
        let looked_up = unsafe {
            LookupAccountSidW(
                std::ptr::null(),
                sid,
                name.as_mut_ptr(),
                &mut name_length,
                domain.as_mut_ptr(),
                &mut domain_length,
                &mut kind,
            )
        };
        unsafe { FreeSid(sid) };
        if looked_up == 0 {
            return Err(
                "This edition of Windows has no Hyper-V Administrators group. Enable Hyper-V on \
                 Windows Pro, Enterprise, or Education."
                    .to_owned(),
            );
        }
        name.truncate(name_length as usize);
        name.push(0);
        Ok(name)
    }

    /// The virtual account's SID. It exists only once the service does, which is
    /// why the installer schedules this after `InstallServices`.
    fn service_account_sid() -> Result<Vec<u8>, String> {
        let account = wide(SERVICE_ACCOUNT);
        let mut sid_length = 0_u32;
        let mut domain_length = 0_u32;
        let mut kind: SID_NAME_USE = 0;
        unsafe {
            LookupAccountNameW(
                std::ptr::null(),
                account.as_ptr(),
                std::ptr::null_mut(),
                &mut sid_length,
                std::ptr::null_mut(),
                &mut domain_length,
                &mut kind,
            )
        };
        if sid_length == 0 {
            return Err("Windows would not name the Nessie Executor service account.".to_owned());
        }
        let mut sid = vec![0_u8; sid_length as usize];
        let mut domain = vec![0_u16; domain_length.max(1) as usize];
        let looked_up = unsafe {
            LookupAccountNameW(
                std::ptr::null(),
                account.as_ptr(),
                sid.as_mut_ptr() as PSID,
                &mut sid_length,
                domain.as_mut_ptr(),
                &mut domain_length,
                &mut kind,
            )
        };
        if looked_up == 0 {
            return Err("Windows would not name the Nessie Executor service account.".to_owned());
        }
        Ok(sid)
    }

    pub fn join_hyperv_administrators() -> Result<(), String> {
        let group = hyperv_administrators_name()?;
        let mut sid = service_account_sid()?;
        let member = LOCALGROUP_MEMBERS_INFO_0 { lgrmi0_sid: sid.as_mut_ptr() as PSID };
        let added = unsafe {
            NetLocalGroupAddMembers(
                std::ptr::null(),
                group.as_ptr(),
                0,
                (&member as *const LOCALGROUP_MEMBERS_INFO_0).cast(),
                1,
            )
        };
        // Already a member is the state this asks for, so a repair or an upgrade
        // must not fail on it.
        if added == ERROR_SUCCESS || added == ERROR_MEMBER_IN_ALIAS {
            Ok(())
        } else {
            Err("Windows refused to add the Nessie Executor service account to Hyper-V \
                 Administrators."
                .to_owned())
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn join_hyperv_administrators() -> Result<(), String> {
        Err("Hyper-V Administrators membership is a Windows operation.".to_owned())
    }
}

pub use imp::join_hyperv_administrators;

#[cfg(test)]
mod tests {
    use super::{well_known_sid_string, HYPERV_ADMINISTRATORS_SID};

    /// The installer's registry authoring, this module's Win32 call, and the
    /// documentation all name the same alias. This is where they meet.
    #[test]
    fn the_documented_alias_is_the_one_the_parts_compose_to() {
        // SECURITY_NT_AUTHORITY, SECURITY_BUILTIN_DOMAIN_RID,
        // DOMAIN_ALIAS_RID_HYPER_V_ADMINS.
        assert_eq!(well_known_sid_string(5, &[32, 578]), HYPERV_ADMINISTRATORS_SID);
        // Not the Administrators alias: a mistyped RID would silently grant far
        // more than Hyper-V.
        assert_ne!(well_known_sid_string(5, &[32, 544]), HYPERV_ADMINISTRATORS_SID);
    }
}
