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
	"syscall"
	"time"
)

const (
	commandHomeDirectory            = "/work/.nessie-executor/command"
	commandConformanceProbeArgument = "nessie-command-conformance-probe"
	commandSandboxRunnerArgument    = "nessie-command-sandbox-runner"
	maxCommandOutputBytes           = 8 * 1_024
	maxCommandRuntimeSeconds        = 300
)

type commandRequest struct {
	Args           []string
	CWD            string
	MaxResultBytes int
	Program        string
	RuntimeSeconds int
}

type commandResult struct {
	ExitCode int    `json:"exitCode"`
	Output   string `json:"output"`
	Success  bool   `json:"success"`
}

type commandRunner func(string, commandRequest) (commandResult, error)
type commandSandboxConformer func(string) error

type commandRuntime struct {
	codex       string
	conform     commandSandboxConformer
	prepared    bool
	profileRoot string
	run         commandRunner
	mu          sync.Mutex
}

func newCommandRuntime(manifest *runtimeManifest) *commandRuntime {
	if manifest == nil || manifest.Entrypoints["codex"] == "" {
		return nil
	}
	return &commandRuntime{
		codex:       filepath.Join("/runtime", filepath.FromSlash(manifest.Entrypoints["codex"])),
		conform:     conformCommandSandbox,
		profileRoot: "/work",
		run:         runCommandSandbox,
	}
}

func (runtime *commandRuntime) execute(request commandRequest) (commandResult, error) {
	if !validCommandRequest(request) {
		return commandResult{}, errInvalidFrame
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if !runtime.prepared {
		if runtime.conform == nil || runtime.conform(runtime.codex) != nil {
			return commandResult{}, errInvalidFrame
		}
		if err := secureBrowserProfile(runtime.profileRoot, commandHomeDirectory); err != nil {
			return commandResult{}, err
		}
		if err := os.Mkdir(filepath.Join(commandHomeDirectory, "tmp"), 0o700); err != nil {
			return commandResult{}, err
		}
		runtime.prepared = true
	}
	return runtime.run(runtime.codex, request)
}

// Command execution uses the same pinned Codex sandbox profile as the coding
// lane. This is a launch gate: a changed runtime binary or a weakened profile
// must prove that a child cannot read the executor-control canary or open the
// guest egress socket before any model-provided argv is started.
func conformCommandSandbox(codex string) error {
	if codex == "" {
		return errInvalidFrame
	}
	args := []string{"sandbox", "-P", codingSandboxProfile}
	args = append(args, codexSandboxConfiguration()...)
	args = append(args, "/init", commandConformanceProbeArgument, codex)
	command := exec.Command(codex, args...)
	command.Dir = "/work"
	command.Env = commandEnvironment()
	output := &boundedCommandOutput{maximum: maxCommandOutputBytes}
	command.Stdout = output
	command.Stderr = output
	if err := command.Run(); err != nil || output.overflowed {
		return errInvalidFrame
	}
	return nil
}

func validCommandRequest(request commandRequest) bool {
	if !validCommandProgram(request.Program) || len(request.Args) > 64 || request.RuntimeSeconds < 1 || request.RuntimeSeconds > maxCommandRuntimeSeconds || request.MaxResultBytes < 1 || request.MaxResultBytes > maxCommandOutputBytes {
		return false
	}
	if request.CWD != "" && !validCommandCWD(request.CWD) {
		return false
	}
	for _, argument := range request.Args {
		if len([]byte(argument)) > 4_096 || strings.ContainsRune(argument, '\x00') {
			return false
		}
	}
	return true
}

func validCommandProgram(value string) bool {
	if value == "" || len([]byte(value)) > 256 || strings.ContainsRune(value, '\x00') || strings.Contains(value, "/") {
		return false
	}
	switch value {
	case "bash", "dash", "fish", "ksh", "sh", "zsh":
		return false
	default:
		return true
	}
}

func validCommandCWD(value string) bool {
	return value == "." || (!strings.HasPrefix(value, "/") && allCommandPathSegments(value))
}

func allCommandPathSegments(value string) bool {
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func commandDirectory(cwd string) (string, error) {
	if cwd == "" || cwd == "." {
		return "/work", nil
	}
	if !validCommandCWD(cwd) {
		return "", errInvalidFrame
	}
	current := "/work"
	for _, segment := range strings.Split(cwd, "/") {
		current = filepath.Join(current, segment)
		info, err := os.Lstat(current)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", errInvalidFrame
		}
	}
	return current, nil
}

func runCommandSandbox(sandbox string, request commandRequest) (commandResult, error) {
	directory, err := commandDirectory(request.CWD)
	if err != nil {
		return commandResult{}, err
	}
	args := []string{"sandbox", "-P", codingSandboxProfile}
	args = append(args, codexSandboxConfiguration()...)
	args = append(args, "/init", commandSandboxRunnerArgument, request.Program)
	args = append(args, request.Args...)
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(request.RuntimeSeconds)*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, sandbox, args...)
	command.Dir = directory
	command.Env = commandEnvironment()
	command.SysProcAttr = commandSandboxSysProcAttr()
	output := &boundedCommandOutput{maximum: request.MaxResultBytes}
	command.Stdout = output
	command.Stderr = output
	restoreLimits, err := constrainCommandResources(request.RuntimeSeconds)
	if err != nil {
		return commandResult{}, err
	}
	if err := command.Start(); err != nil {
		restoreLimits()
		return commandResult{}, err
	}
	restoreLimits()
	wait := make(chan error, 1)
	go func() { wait <- command.Wait() }()
	var runErr error
	select {
	case runErr = <-wait:
	case <-ctx.Done():
		_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		runErr = <-wait
	}
	if ctx.Err() != nil || output.overflowed {
		return commandResult{}, errInvalidFrame
	}
	exitCode := 0
	if runErr != nil {
		var exitError *exec.ExitError
		if !errors.As(runErr, &exitError) {
			return commandResult{}, errInvalidFrame
		}
		exitCode = exitError.ExitCode()
		if exitCode < 0 || exitCode > 255 {
			return commandResult{}, errInvalidFrame
		}
	}
	return commandResult{ExitCode: exitCode, Output: output.String(), Success: exitCode == 0}, nil
}

func commandEnvironment() []string {
	return []string{
		"HOME=" + commandHomeDirectory,
		"TMPDIR=" + commandHomeDirectory + "/tmp",
		"PATH=/runtime/bin:/usr/bin:/bin",
		"LANG=C",
	}
}

type commandResourceLimit struct {
	maximum  uint64
	resource int
}

// The parent restores its own soft limits immediately after fork. The child
// retains the bounded values while the VM ceiling and Codex sandbox provide a
// second resource and privilege boundary around the untrusted argv program.
func constrainCommandResources(runtimeSeconds int) (func(), error) {
	limits := []commandResourceLimit{
		{maximum: uint64(runtimeSeconds + 2), resource: syscall.RLIMIT_CPU},
		{maximum: 1 << 30, resource: syscall.RLIMIT_AS},
		{maximum: 16 << 20, resource: syscall.RLIMIT_FSIZE},
		{maximum: 128, resource: syscall.RLIMIT_NOFILE},
	}
	limits = append(limits, commandAdditionalResourceLimits()...)
	type originalLimit struct {
		resource int
		value    syscall.Rlimit
	}
	originals := make([]originalLimit, 0, len(limits))
	for _, limit := range limits {
		var original syscall.Rlimit
		if err := syscall.Getrlimit(limit.resource, &original); err != nil {
			return func() {}, err
		}
		next := original
		if next.Cur > limit.maximum {
			next.Cur = limit.maximum
		}
		if err := syscall.Setrlimit(limit.resource, &next); err != nil {
			for index := len(originals) - 1; index >= 0; index-- {
				_ = syscall.Setrlimit(originals[index].resource, &originals[index].value)
			}
			return func() {}, err
		}
		originals = append(originals, originalLimit{resource: limit.resource, value: original})
	}
	return func() {
		for index := len(originals) - 1; index >= 0; index-- {
			_ = syscall.Setrlimit(originals[index].resource, &originals[index].value)
		}
	}, nil
}

type boundedCommandOutput struct {
	bytes.Buffer
	maximum    int
	overflowed bool
}

func (output *boundedCommandOutput) Write(value []byte) (int, error) {
	if output.Len()+len(value) > output.maximum {
		output.overflowed = true
		return 0, errInvalidFrame
	}
	return output.Buffer.Write(value)
}

// The fixed `/init` child is entered only through the pinned Codex sandbox.
// It receives an argv vector directly and never constructs a shell command.
func runCommandSandboxRunner(arguments []string) int {
	if len(arguments) < 1 || !validCommandProgram(arguments[0]) {
		return 64
	}
	for _, argument := range arguments[1:] {
		if len([]byte(argument)) > 4_096 || strings.ContainsRune(argument, '\x00') {
			return 64
		}
	}
	path, err := exec.LookPath(arguments[0])
	if err != nil {
		return 127
	}
	if err := syscall.Exec(path, arguments, commandEnvironment()); err != nil {
		return 126
	}
	return 126
}
