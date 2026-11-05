//go:build linux

package main

import (
	"net"
	"os"
	"os/exec"
	"strconv"
	"time"
)

// runCodingConformanceProbe is executed only inside the Codex-provided
// workspace-write sandbox. It succeeds only when that sandbox, including its
// inherited restrictions after a nested danger-full-access Codex invocation,
// cannot read the auth canary or reach the guest-local egress proxy.
func runCodingConformanceProbe(arguments []string) int {
	if len(arguments) > 1 {
		return 64
	}
	for _, protected := range []string{codingCredentialCanary, codingControlCanary} {
		for _, candidate := range []string{
			protected,
			"/proc/self/root" + protected,
			"/proc/" + strconv.Itoa(os.Getppid()) + "/root" + protected,
		} {
			if descriptor, err := os.Open(candidate); err == nil {
				_ = descriptor.Close()
				return 65
			}
		}
	}
	controlConnection, err := net.DialTimeout("unix", codingSocketPath, 500*time.Millisecond)
	if err == nil {
		_ = controlConnection.Close()
		return 66
	}
	if !codingSandboxDenied(err) {
		return 66
	}
	connection, err := net.DialTimeout("tcp4", guestEgressProxyAddress, 500*time.Millisecond)
	if err == nil {
		_ = connection.Close()
		return 66
	}
	if !codingSandboxDenied(err) {
		return 66
	}
	if len(arguments) == 0 {
		return 0
	}
	codex := arguments[0]
	command := exec.Command(codex, "sandbox", "-P", ":danger-full-access", "/init", codingConformanceProbeArgument)
	command.Dir = "/work"
	command.Env = codingConformanceEnvironment()
	if err := command.Run(); err != nil {
		return 67
	}
	return 0
}
