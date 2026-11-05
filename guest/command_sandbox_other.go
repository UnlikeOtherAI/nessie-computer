//go:build !linux

package main

import "syscall"

// Guest execution is Linux-only. This keeps static host verification portable
// while the Linux implementation above retains the parent-death guard.
func commandSandboxSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

func commandAdditionalResourceLimits() []commandResourceLimit { return nil }
