//go:build linux

package main

import (
	"os"
	"syscall"
)

func guestIdentityForWorkspace(workspaceAttached bool) (guestIdentity, error) {
	var workspaceUserID uint32
	var workspaceGroupID uint32
	if workspaceAttached {
		info, err := os.Stat("/work")
		if err != nil {
			return guestIdentity{}, err
		}
		metadata, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return guestIdentity{}, errInvalidFrame
		}
		workspaceUserID = metadata.Uid
		workspaceGroupID = metadata.Gid
	}
	return selectGuestIdentity(workspaceAttached, workspaceUserID, workspaceGroupID)
}

func dropGuestPrivileges(workspaceAttached bool) error {
	identity, err := guestIdentityForWorkspace(workspaceAttached)
	if err != nil {
		return err
	}
	return dropGuestPrivilegesTo(identity)
}

func dropGuestPrivilegesTo(identity guestIdentity) error {
	if err := syscall.Setgroups([]int{int(identity.groupID)}); err != nil {
		return err
	}
	if err := syscall.Setgid(int(identity.groupID)); err != nil {
		return err
	}
	if err := syscall.Setuid(int(identity.userID)); err != nil {
		return err
	}
	if os.Geteuid() != int(identity.userID) || os.Getegid() != int(identity.groupID) {
		return errInvalidFrame
	}
	return nil
}
