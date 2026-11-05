//go:build linux

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestMaterializeCodexAuthProfileStagesOnlyAnOwnerPrivateGuestCopy(t *testing.T) {
	previousSource := codingAuthProfileSource
	previousDestination := codingAuthProfileDestination
	temporary := t.TempDir()
	codingAuthProfileSource = filepath.Join(temporary, "initrd-auth.json")
	codingAuthProfileDestination = filepath.Join(temporary, "guest", "auth.json")
	t.Cleanup(func() {
		codingAuthProfileSource = previousSource
		codingAuthProfileDestination = previousDestination
	})
	if err := os.Mkdir(filepath.Dir(codingAuthProfileDestination), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(codingAuthProfileSource, []byte(`{"auth_mode":"chatgpt"}`), 0o400); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(codingAuthProfileSource, 0o400); err != nil {
		t.Fatal(err)
	}
	identity := guestIdentity{groupID: guestFallbackID, userID: guestFallbackID}
	if err := materializeCodexAuthProfile(identity); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(codingAuthProfileSource); !os.IsNotExist(err) {
		t.Fatalf("root-only initrd profile remains available: %v", err)
	}
	contents, err := os.ReadFile(codingAuthProfileDestination)
	if err != nil || string(contents) != `{"auth_mode":"chatgpt"}` {
		t.Fatalf("unexpected guest auth profile %q: %v", contents, err)
	}
	info, err := os.Lstat(codingAuthProfileDestination)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		t.Fatalf("guest auth profile is insecure: %v %#o", err, info.Mode())
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || metadata.Uid != identity.userID || metadata.Gid != identity.groupID || metadata.Nlink != 1 {
		t.Fatal("guest auth profile has the wrong ownership or links")
	}
}

func TestMaterializeCodexAuthProfileRejectsSharedInitrdSource(t *testing.T) {
	previousSource := codingAuthProfileSource
	previousDestination := codingAuthProfileDestination
	temporary := t.TempDir()
	codingAuthProfileSource = filepath.Join(temporary, "initrd-auth.json")
	codingAuthProfileDestination = filepath.Join(temporary, "guest", "auth.json")
	t.Cleanup(func() {
		codingAuthProfileSource = previousSource
		codingAuthProfileDestination = previousDestination
	})
	if err := os.Mkdir(filepath.Dir(codingAuthProfileDestination), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(codingAuthProfileSource, []byte(`{"auth_mode":"chatgpt"}`), 0o444); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(codingAuthProfileSource, 0o444); err != nil {
		t.Fatal(err)
	}
	if err := materializeCodexAuthProfile(guestIdentity{groupID: guestFallbackID, userID: guestFallbackID}); err == nil {
		t.Fatal("accepted a group-readable initrd auth profile")
	}
}
