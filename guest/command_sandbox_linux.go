//go:build linux

package main

import "syscall"

// Linux UAPI `RLIMIT_NPROC`; syscall does not expose this constant on every
// supported Go target even though Setrlimit accepts the numeric resource.
const commandRLimitNProc = 6

func commandSandboxSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL, Setpgid: true}
}

func commandAdditionalResourceLimits() []commandResourceLimit {
	return []commandResourceLimit{{maximum: 64, resource: commandRLimitNProc}}
}
