//go:build linux

package main

import (
	"net"
	"os"
	"os/exec"
	"strconv"
	"time"
)

// runCommandConformanceProbe runs only inside the configured Codex sandbox.
// Command VMs deliberately have no egress gateway, so a connection refusal is
// not sufficient proof: this requires the sandbox's explicit denial instead.
func runCommandConformanceProbe(arguments []string) int {
	if len(arguments) > 1 {
		return 64
	}
	for _, candidate := range []string{
		codingControlCanary,
		"/proc/self/root" + codingControlCanary,
		"/proc/" + strconv.Itoa(os.Getppid()) + "/root" + codingControlCanary,
	} {
		if descriptor, err := os.Open(candidate); err == nil {
			_ = descriptor.Close()
			return 65
		}
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
	command := exec.Command(codex, "sandbox", "-P", ":danger-full-access", "/init", commandConformanceProbeArgument)
	command.Dir = "/work"
	command.Env = commandEnvironment()
	if err := command.Run(); err != nil {
		return 67
	}
	return 0
}
