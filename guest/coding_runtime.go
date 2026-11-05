package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	codingConfigPath               = "/run/nessie-executor/tmux.conf"
	codingControlCanary            = "/run/nessie-executor/control-canary"
	codingControlDirectory         = "/run/nessie-executor"
	codingCredentialHome           = "/run/nessie-executor/codex-home"
	codingCredentialCanary         = codingCredentialHome + "/auth-canary"
	codingCredentialBootstrapPath  = "/etc/nessie/codex-auth.json"
	codingProfileRoot              = "/work"
	codingSessionName              = "nessie"
	codingSocketPath               = "/run/nessie-executor/tmux/session.sock"
	codingSessionTarget            = "=nessie"
	codingTarget                   = "=nessie:0.0"
	codingSandboxProfile           = "nessie-executor"
	codingConformanceProbeArgument = "nessie-codex-conformance-probe"
	// Each fixed tmux status probe stays comfortably below the authenticated
	// guest-control frame cap. Terminal panes are never captured or returned.
	maxCodingObserveBytes = 8_192
	maxCodingPromptBytes  = 16_384
	codingCommandTimeout  = 5 * time.Second
)

type codingAgent string

const (
	codingAgentClaude codingAgent = "claude"
	codingAgentCodex  codingAgent = "codex"
)

type codingObservation struct {
	Agent      codingAgent `json:"agent"`
	ExitStatus *int        `json:"exitStatus,omitempty"`
	Lifecycle  string      `json:"lifecycle"`
}

type codingCommandRunner func(path string, args, environment []string) ([]byte, error)

type codingRuntime struct {
	agentExecutables map[codingAgent]string
	agent            codingAgent
	environment      []string
	launched         bool
	mu               sync.Mutex
	run              codingCommandRunner
	socket           string
	tmux             string
	profileRoot      string
}

func codexSandboxConfiguration() []string {
	return []string{
		"-c", "permissions." + codingSandboxProfile + ".extends=\":workspace\"",
		"-c", "permissions." + codingSandboxProfile + ".filesystem={\"" + codingControlDirectory + "\"=\"deny\"}",
		"-c", "permissions." + codingSandboxProfile + ".network.enabled=false",
	}
}

func newCodingRuntime(manifest *runtimeManifest) *codingRuntime {
	if manifest == nil || manifest.Entrypoints["tmux"] == "" || !hasCodingCredentialBootstrap() {
		return nil
	}
	agents := map[codingAgent]string{}
	if entrypoint := manifest.Entrypoints["codex"]; entrypoint != "" {
		agents[codingAgentCodex] = filepath.Join("/runtime", filepath.FromSlash(entrypoint))
	}
	if entrypoint := manifest.Entrypoints["claude"]; entrypoint != "" {
		agents[codingAgentClaude] = filepath.Join("/runtime", filepath.FromSlash(entrypoint))
	}
	if len(agents) == 0 {
		return nil
	}
	return &codingRuntime{
		agentExecutables: agents,
		run:              runCodingCommand,
		socket:           codingSocketPath,
		tmux:             filepath.Join("/runtime", filepath.FromSlash(manifest.Entrypoints["tmux"])),
		profileRoot:      codingProfileRoot,
	}
}

func hasCodingCredentialBootstrap() bool {
	info, err := os.Lstat(codingCredentialBootstrapPath)
	return err == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0
}

func validCodingAgent(value codingAgent) bool {
	return value == codingAgentClaude || value == codingAgentCodex
}

func (runtime *codingRuntime) launch(agent codingAgent, prompt string) error {
	if !validCodingAgent(agent) || !validCodingPrompt(prompt) {
		return errInvalidFrame
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.launched || runtime.agentExecutables[agent] == "" || runtime.socketExists() {
		return errInvalidFrame
	}
	if agent == codingAgentCodex && runtime.conformCodexSandbox() != nil {
		return errInvalidFrame
	}
	profile := filepath.Join(runtime.profileRoot, ".nessie-executor", "coding", string(agent))
	if agent != codingAgentCodex {
		if err := secureBrowserProfile(runtime.profileRoot, profile); err != nil {
			return err
		}
	}
	environment := codingEnvironment(agent, profile)
	argv := []string{
		"-f", codingConfigPath,
		"-S", runtime.socket,
		"new-session", "-d", "-s", codingSessionName, "--",
		runtime.agentExecutables[agent],
	}
	if agent == codingAgentCodex {
		argv = append(argv, codexLaunchArguments(prompt)...)
	}
	if _, err := runtime.invoke(argv, environment); err != nil {
		return err
	}
	runtime.launched = true
	runtime.agent = agent
	runtime.environment = environment
	return nil
}

func validCodingPrompt(value string) bool {
	return value != "" && len([]byte(value)) <= maxCodingPromptBytes
}

func (runtime *codingRuntime) observation() (codingObservation, error) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if !runtime.launched {
		return codingObservation{}, errInvalidFrame
	}
	lifecycle, exitStatus, err := runtime.lifecycle()
	if err != nil {
		return codingObservation{}, err
	}
	return codingObservation{Agent: runtime.agent, ExitStatus: exitStatus, Lifecycle: lifecycle}, nil
}

func (runtime *codingRuntime) close() error {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if !runtime.launched {
		return errInvalidFrame
	}
	if _, err := runtime.invoke([]string{"-S", runtime.socket, "kill-session", "-t", codingSessionTarget}, runtime.environment); err != nil {
		return err
	}
	runtime.launched = false
	runtime.agent = ""
	runtime.environment = nil
	return nil
}

func (runtime *codingRuntime) shutdown() {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.launched {
		_, _ = runtime.invoke([]string{"-S", runtime.socket, "kill-session", "-t", codingSessionTarget}, runtime.environment)
	}
	runtime.launched = false
	runtime.agent = ""
	runtime.environment = nil
}

func (runtime *codingRuntime) lifecycle() (string, *int, error) {
	output, err := runtime.invoke([]string{
		"-S", runtime.socket,
		"display-message", "-p", "-t", codingTarget, "#{pane_dead}\t#{pane_dead_status}",
	}, runtime.environment)
	if err != nil {
		return "", nil, err
	}
	parts := strings.Split(strings.TrimSuffix(string(output), "\n"), "\t")
	if len(parts) != 2 || (parts[0] != "0" && parts[0] != "1") {
		return "", nil, errInvalidFrame
	}
	if parts[0] == "0" {
		if parts[1] != "" {
			return "", nil, errInvalidFrame
		}
		return "running", nil, nil
	}
	status, ok := parseCodingExitStatus(parts[1])
	if !ok {
		return "", nil, errInvalidFrame
	}
	return "exited", &status, nil
}

func parseCodingExitStatus(value string) (int, bool) {
	if value == "" || len(value) > 3 {
		return 0, false
	}
	status := 0
	for _, character := range value {
		if character < '0' || character > '9' {
			return 0, false
		}
		status = status*10 + int(character-'0')
	}
	return status, status <= 255
}

func (runtime *codingRuntime) socketExists() bool {
	_, err := os.Lstat(runtime.socket)
	return err == nil || !errors.Is(err, os.ErrNotExist)
}

func (runtime *codingRuntime) invoke(args, environment []string) ([]byte, error) {
	if len(args) == 0 || runtime.run == nil {
		return nil, errInvalidFrame
	}
	return runtime.run(runtime.tmux, args, environment)
}

// A coding process is an authenticated parent and its model-generated shell
// commands are untrusted children. The exact pinned Codex binary must prove
// that a workspace-write child cannot read the auth home or use the guest's
// loopback egress proxy, even by nesting a Codex sandbox with full access.
// This is deliberately a launch gate rather than an advisory self-check.
func (runtime *codingRuntime) conformCodexSandbox() error {
	codex := runtime.agentExecutables[codingAgentCodex]
	if codex == "" || runtime.run == nil {
		return errInvalidFrame
	}
	args := []string{"sandbox", "-P", codingSandboxProfile}
	args = append(args, codexSandboxConfiguration()...)
	args = append(args, "/init", codingConformanceProbeArgument, codex)
	_, err := runtime.run(codex, args, codingConformanceEnvironment())
	return err
}

func codingEnvironment(agent codingAgent, profile string) []string {
	if agent == codingAgentCodex {
		return append(codingConformanceEnvironment(),
			"CODEX_HOME="+codingCredentialHome,
			"HTTP_PROXY=http://"+guestEgressProxyAddress,
			"HTTPS_PROXY=http://"+guestEgressProxyAddress,
			"PATH=/runtime/bin:/usr/bin:/bin",
		)
	}
	return []string{"HOME=" + profile, "TMPDIR=" + profile, "CLAUDE_CONFIG_DIR=" + filepath.Join(profile, "state")}
}

func codingConformanceEnvironment() []string {
	return []string{
		"HOME=" + codingCredentialHome,
		"TMPDIR=" + codingCredentialHome + "/tmp",
	}
}

func codexLaunchArguments(prompt string) []string {
	args := append([]string{}, codexSandboxConfiguration()...)
	return append(args,
		"-c", "default_permissions=\""+codingSandboxProfile+"\"",
		"--ignore-rules",
		"--ignore-user-config",
		"--skip-git-repo-check",
		"exec",
		"--",
		prompt,
	)
}

func runCodingCommand(path string, args, environment []string) ([]byte, error) {
	commandContext, cancel := context.WithTimeout(context.Background(), codingCommandTimeout)
	defer cancel()
	command := exec.CommandContext(commandContext, path, args...)
	command.Dir = "/work"
	if environment != nil {
		command.Env = environment
	}
	output := &boundedCodingOutput{maximum: maxCodingObserveBytes}
	command.Stdout = output
	command.Stderr = output
	err := command.Run()
	if commandContext.Err() != nil || output.overflowed || err != nil {
		return nil, errInvalidFrame
	}
	return output.Bytes(), nil
}

type boundedCodingOutput struct {
	bytes.Buffer
	maximum    int
	overflowed bool
}

func (output *boundedCodingOutput) Write(value []byte) (int, error) {
	if output.Len()+len(value) > output.maximum {
		output.overflowed = true
		return 0, errInvalidFrame
	}
	return output.Buffer.Write(value)
}
