//! Active login profiles observed from Windows, for SYSTEM installer completion.
use crate::process::{self, Owned, Process};
use std::{collections::BTreeSet, mem::size_of, path::PathBuf};
use windows_sys::Win32::{
    Foundation::HANDLE,
    Security::{GetTokenInformation, TokenUser, TOKEN_USER},
    System::RemoteDesktop::{WTSActive, WTSEnumerateSessionsW, WTSFreeMemory, WTSQueryUserToken},
};

fn token_owner(token: HANDLE) -> Option<String> {
    let mut size = 0;
    unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size) };
    if size == 0 || size > 65_536 {
        return None;
    }
    let mut bytes = vec![0_usize; (size as usize).div_ceil(size_of::<usize>())];
    if unsafe { GetTokenInformation(token, TokenUser, bytes.as_mut_ptr().cast(), size, &mut size) }
        == 0
    {
        return None;
    }
    let user = unsafe { &*bytes.as_ptr().cast::<TOKEN_USER>() };
    crate::sid_to_string(user.User.Sid)
}

/// No account name, profile path, SID or session is supplied by the caller.
pub(super) fn active() -> BTreeSet<(PathBuf, String)> {
    let mut profiles = BTreeSet::new();
    if Process::open(std::process::id()).map_or(true, |caller| caller.sid != "S-1-5-18") {
        return profiles;
    }
    let mut sessions = std::ptr::null_mut();
    let mut count = 0;
    if unsafe { WTSEnumerateSessionsW(std::ptr::null_mut(), 0, 1, &mut sessions, &mut count) } == 0
    {
        return profiles;
    }
    if count <= 1024 && !sessions.is_null() {
        for session in unsafe { std::slice::from_raw_parts(sessions, count as usize) } {
            if session.State != WTSActive || session.SessionId == 0 {
                continue;
            }
            let Ok(owner) = process::session_owner(session.SessionId) else {
                continue;
            };
            let mut token = std::ptr::null_mut();
            if unsafe { WTSQueryUserToken(session.SessionId, &mut token) } == 0 {
                continue;
            }
            let token = Owned(token);
            if token_owner(token.0).as_deref() != Some(owner.as_str()) {
                continue;
            }
            if let Ok(profile) = process::token_profile(token.0) {
                profiles.insert((profile, owner));
            }
        }
    }
    if !sessions.is_null() {
        unsafe { WTSFreeMemory(sessions.cast()) };
    }
    profiles
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "requires SYSTEM and an active interactive Windows login; read-only"]
    fn system_completion_resolves_active_login_profiles() {
        assert_eq!(
            super::Process::open(std::process::id()).unwrap().sid,
            "S-1-5-18"
        );
        let profiles = super::active();
        assert!(
            !profiles.is_empty(),
            "SYSTEM must resolve the active login profile"
        );
        for (profile, owner) in &profiles {
            assert!(profile.is_absolute() && profile.is_dir());
            assert!(owner.starts_with("S-1-5-21-") || owner.starts_with("S-1-12-1-"));
        }
        println!(
            "Resolved {} active login profile(s); no files changed",
            profiles.len()
        );
    }

    #[test]
    fn an_ordinary_or_elevated_user_cannot_enumerate_installer_profiles() {
        if super::Process::open(std::process::id()).unwrap().sid != "S-1-5-18" {
            assert!(super::active().is_empty());
        }
    }
}
