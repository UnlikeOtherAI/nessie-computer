//go:build linux

package main

import (
	"io"
	"os"
	"syscall"
)

const (
	codingRuntimeDirectory    = "/run/nessie-executor"
	maxCodingAuthProfileBytes = 1_048_576
)

var (
	codingAuthProfileSource      = codingCredentialBootstrapPath
	codingAuthProfileDestination = codingCredentialHome + "/auth.json"
)

// prepareCodingRuntime creates the immutable tmux configuration before the
// guest drops privileges. The socket directory is private to the one guest
// identity; the configuration remains root-owned so a coding CLI cannot alter
// its lifecycle policy after launch.
func prepareCodingRuntime(identity guestIdentity) error {
	if err := os.Mkdir("/run", 0o755); err != nil && !os.IsExist(err) {
		return err
	}
	if err := os.Mkdir(codingRuntimeDirectory, 0o755); err != nil && !os.IsExist(err) {
		return err
	}
	info, err := os.Lstat(codingRuntimeDirectory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errInvalidFrame
	}
	if err := os.Chmod(codingRuntimeDirectory, 0o755); err != nil {
		return err
	}
	if err := prepareCodingControlCanary(identity); err != nil {
		return err
	}
	if err := prepareCodexCredentialHome(identity); err != nil {
		return err
	}
	configFile, err := os.OpenFile(codingConfigPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o444)
	if err != nil {
		return err
	}
	if _, err := configFile.WriteString("set-option -g remain-on-exit on\nset-option -g status off\n"); err != nil {
		_ = configFile.Close()
		return err
	}
	if err := configFile.Close(); err != nil {
		return err
	}
	if err := os.Chmod(codingConfigPath, 0o444); err != nil {
		return err
	}
	config, err := os.Lstat(codingConfigPath)
	if err != nil || !config.Mode().IsRegular() || config.Mode()&os.ModeSymlink != 0 || config.Mode().Perm() != 0o444 {
		return errInvalidFrame
	}
	metadata, ok := config.Sys().(*syscall.Stat_t)
	if !ok || metadata.Uid != 0 || metadata.Gid != 0 {
		return errInvalidFrame
	}
	if err := os.Mkdir("/run/nessie-executor/tmux", 0o700); err != nil && !os.IsExist(err) {
		return err
	}
	if err := os.Chown("/run/nessie-executor/tmux", int(identity.userID), int(identity.groupID)); err != nil {
		return err
	}
	if err := os.Chmod("/run/nessie-executor/tmux", 0o700); err != nil {
		return err
	}
	socketDirectory, err := os.Lstat("/run/nessie-executor/tmux")
	if err != nil || !socketDirectory.IsDir() || socketDirectory.Mode()&os.ModeSymlink != 0 || socketDirectory.Mode().Perm() != 0o700 {
		return errInvalidFrame
	}
	socketMetadata, ok := socketDirectory.Sys().(*syscall.Stat_t)
	if !ok || socketMetadata.Uid != identity.userID || socketMetadata.Gid != identity.groupID {
		return errInvalidFrame
	}
	return nil
}

// Command-only guest images deliberately do not materialize a Codex auth
// profile or tmux state. They still need the root-created control canary that
// the shared no-network/no-control-directory sandbox conformance probe reads.
func prepareCommandRuntime(identity guestIdentity) error {
	if err := os.Mkdir("/run", 0o755); err != nil && !os.IsExist(err) {
		return err
	}
	if err := os.Mkdir(codingRuntimeDirectory, 0o755); err != nil && !os.IsExist(err) {
		return err
	}
	info, err := os.Lstat(codingRuntimeDirectory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errInvalidFrame
	}
	if err := os.Chmod(codingRuntimeDirectory, 0o755); err != nil {
		return err
	}
	return prepareCodingControlCanary(identity)
}

// The canary sits beside the tmux socket. A passing Codex conformance probe
// must be unable to read it, protecting the other executor-private control
// files in this directory; the probe separately verifies that it cannot
// connect to the same-UID tmux control socket.
func prepareCodingControlCanary(identity guestIdentity) error {
	canary, err := os.OpenFile(codingControlCanary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o400)
	if err != nil {
		return err
	}
	if _, err := canary.WriteString("nessie-codex-control-canary\n"); err != nil {
		_ = canary.Close()
		return err
	}
	if err := canary.Close(); err != nil {
		return err
	}
	if err := os.Chown(codingControlCanary, int(identity.userID), int(identity.groupID)); err != nil {
		return err
	}
	info, err := os.Lstat(codingControlCanary)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o400 {
		return errInvalidFrame
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || metadata.Uid != identity.userID || metadata.Gid != identity.groupID {
		return errInvalidFrame
	}
	return nil
}

// The home is deliberately outside `/work`: the only principal allowed to
// read it is the outer Codex process. Its own pinned workspace-write sandbox
// receives an explicit deny for this path and is conformance-tested before
// launch. The canary is non-secret, but proves that policy is effective before
// an auth profile is ever materialized here.
func prepareCodexCredentialHome(identity guestIdentity) error {
	if err := os.Mkdir(codingCredentialHome, 0o700); err != nil && !os.IsExist(err) {
		return err
	}
	info, err := os.Lstat(codingCredentialHome)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errInvalidFrame
	}
	if err := os.Chown(codingCredentialHome, int(identity.userID), int(identity.groupID)); err != nil {
		return err
	}
	if err := os.Chmod(codingCredentialHome, 0o700); err != nil {
		return err
	}
	if err := os.Mkdir(codingCredentialHome+"/tmp", 0o700); err != nil && !os.IsExist(err) {
		return err
	}
	if err := os.Chown(codingCredentialHome+"/tmp", int(identity.userID), int(identity.groupID)); err != nil {
		return err
	}
	if err := os.Chmod(codingCredentialHome+"/tmp", 0o700); err != nil {
		return err
	}
	tmpInfo, err := os.Lstat(codingCredentialHome + "/tmp")
	if err != nil || !tmpInfo.IsDir() || tmpInfo.Mode()&os.ModeSymlink != 0 || tmpInfo.Mode().Perm() != 0o700 {
		return errInvalidFrame
	}
	tmpMetadata, ok := tmpInfo.Sys().(*syscall.Stat_t)
	if !ok || tmpMetadata.Uid != identity.userID || tmpMetadata.Gid != identity.groupID {
		return errInvalidFrame
	}
	canary, err := os.OpenFile(codingCredentialCanary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o400)
	if err != nil {
		return err
	}
	if _, err := canary.WriteString("nessie-codex-auth-canary\n"); err != nil {
		_ = canary.Close()
		return err
	}
	if err := canary.Close(); err != nil {
		return err
	}
	if err := os.Chown(codingCredentialCanary, int(identity.userID), int(identity.groupID)); err != nil {
		return err
	}
	canaryInfo, err := os.Lstat(codingCredentialCanary)
	if err != nil || !canaryInfo.Mode().IsRegular() || canaryInfo.Mode()&os.ModeSymlink != 0 || canaryInfo.Mode().Perm() != 0o400 {
		return errInvalidFrame
	}
	metadata, ok := canaryInfo.Sys().(*syscall.Stat_t)
	if !ok || metadata.Uid != identity.userID || metadata.Gid != identity.groupID {
		return errInvalidFrame
	}
	return materializeCodexAuthProfile(identity)
}

// materializeCodexAuthProfile moves the owner-selected profile out of the
// root-only initrd area before privilege drop. A model process cannot mount an
// initrd or access its root-only source; the destination is separately denied
// to Codex's workspace-write children by the launch conformance gate.
func materializeCodexAuthProfile(identity guestIdentity) error {
	sourceInfo, err := os.Lstat(codingAuthProfileSource)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil || !sourceInfo.Mode().IsRegular() || sourceInfo.Mode()&os.ModeSymlink != 0 || sourceInfo.Mode().Perm() != 0o400 || sourceInfo.Size() <= 0 || sourceInfo.Size() > maxCodingAuthProfileBytes {
		return errInvalidFrame
	}
	sourceMetadata, ok := sourceInfo.Sys().(*syscall.Stat_t)
	if !ok || sourceMetadata.Uid != 0 || sourceMetadata.Gid != 0 || sourceMetadata.Nlink != 1 {
		return errInvalidFrame
	}
	sourceDescriptor, err := syscall.Open(codingAuthProfileSource, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	source := os.NewFile(uintptr(sourceDescriptor), codingAuthProfileSource)
	defer source.Close()
	openedInfo, err := source.Stat()
	if err != nil || !os.SameFile(sourceInfo, openedInfo) {
		return errInvalidFrame
	}
	destination, err := os.OpenFile(codingAuthProfileDestination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	written, copyErr := io.Copy(destination, io.LimitReader(source, maxCodingAuthProfileBytes+1))
	if copyErr == nil {
		copyErr = destination.Sync()
	}
	closeErr := destination.Close()
	if copyErr != nil || closeErr != nil || written != sourceInfo.Size() {
		return errInvalidFrame
	}
	if err := os.Chown(codingAuthProfileDestination, int(identity.userID), int(identity.groupID)); err != nil {
		return err
	}
	if err := os.Chmod(codingAuthProfileDestination, 0o600); err != nil {
		return err
	}
	destinationInfo, err := os.Lstat(codingAuthProfileDestination)
	if err != nil || !destinationInfo.Mode().IsRegular() || destinationInfo.Mode()&os.ModeSymlink != 0 || destinationInfo.Mode().Perm() != 0o600 || destinationInfo.Size() != written {
		return errInvalidFrame
	}
	destinationMetadata, ok := destinationInfo.Sys().(*syscall.Stat_t)
	if !ok || destinationMetadata.Uid != identity.userID || destinationMetadata.Gid != identity.groupID || destinationMetadata.Nlink != 1 {
		return errInvalidFrame
	}
	return os.Remove(codingAuthProfileSource)
}
