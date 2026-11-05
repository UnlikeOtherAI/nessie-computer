//go:build !windows

package main

import (
	"errors"
	"os"
	"syscall"
)

// On a POSIX host the proof is the mode bits and the owning uid, which is what
// every other executor artifact check uses. A file with more than one link is
// refused too: a hard link is a second name for one-use session material.
func assertCallerOwnsPrivateFile(info os.FileInfo, modes []os.FileMode) error {
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(metadata.Uid) != os.Getuid() || metadata.Nlink != 1 {
		return errors.New("must be owner-owned and unlinked")
	}
	for _, mode := range modes {
		if info.Mode().Perm() == mode {
			return nil
		}
	}
	return errors.New("has an unexpected mode")
}

func assertCallerOwnsPrivateDirectory(info os.FileInfo) error {
	if info.Mode().Perm() != privateDirectoryMode {
		return errors.New("must be an owner-only directory")
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(metadata.Uid) != os.Getuid() {
		return errors.New("must be owner-only")
	}
	return nil
}
