package main

const guestFallbackID = 65_534

type guestIdentity struct {
	groupID uint32
	userID  uint32
}

// Guest code runs unprivileged after its root-only boot mounts. A COW share
// uses its own visible owner so the guest can edit only that mounted draft; a
// no-workspace session uses the conventional unprivileged fallback identity.
func selectGuestIdentity(workspaceAttached bool, workspaceUserID, workspaceGroupID uint32) (guestIdentity, error) {
	if !workspaceAttached {
		return guestIdentity{groupID: guestFallbackID, userID: guestFallbackID}, nil
	}
	if workspaceUserID == 0 || workspaceGroupID == 0 {
		return guestIdentity{}, errInvalidFrame
	}
	return guestIdentity{groupID: workspaceGroupID, userID: workspaceUserID}, nil
}
