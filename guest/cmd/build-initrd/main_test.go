package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func stageBuilder(t *testing.T) (string, string) {
	t.Helper()
	resources := t.TempDir()
	if err := os.WriteFile(filepath.Join(resources, "init"), []byte("guest-init"), 0o755); err != nil {
		t.Fatal(err)
	}
	session := filepath.Join(t.TempDir(), "session")
	if err := os.Mkdir(session, 0o700); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(resources, "init"), session
}

// members decodes the archive the way the kernel's initramfs unpacker does:
// gzip, then newc headers in order.
func members(t *testing.T, archive []byte) []struct {
	Mode    uint32
	Name    string
	Payload string
} {
	t.Helper()
	reader, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	var decoded []struct {
		Mode    uint32
		Name    string
		Payload string
	}
	offset := 0
	for offset+110 <= len(raw) {
		if string(raw[offset:offset+6]) != cpioMagic {
			t.Fatalf("member at %d is not newc", offset)
		}
		field := func(index int) uint32 {
			start := offset + 6 + (index * 8)
			value, err := hex.DecodeString("0000" + string(raw[start : start+8])[2:])
			if err != nil || len(value) == 0 {
				t.Fatalf("bad field %d", index)
			}
			var parsed uint32
			for _, b := range value {
				parsed = parsed<<8 | uint32(b)
			}
			return parsed
		}
		mode := field(1)
		size := field(6)
		nameSize := field(11)
		nameStart := offset + 110
		name := string(raw[nameStart : nameStart+int(nameSize)-1])
		dataStart := nameStart + int(nameSize)
		if pad := (4 - (dataStart % 4)) % 4; pad != 0 {
			dataStart += pad
		}
		if name == cpioTrailerName {
			break
		}
		decoded = append(decoded, struct {
			Mode    uint32
			Name    string
			Payload string
		}{Mode: mode, Name: name, Payload: string(raw[dataStart : dataStart+int(size)])})
		offset = dataStart + int(size)
		if pad := (4 - (offset % 4)) % 4; pad != 0 {
			offset += pad
		}
	}
	return decoded
}

func TestInitrdCarriesTheGuestInitAndItsOneUseToken(t *testing.T) {
	initPath, session := stageBuilder(t)
	output := filepath.Join(session, "guest-initrd")
	if err := run([]string{
		"--output", output, "--init", initPath, "--bootstrap-token-stdin",
	}, strings.NewReader(testToken)); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(output)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("initrd mode %v", info.Mode().Perm())
	}
	archive, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	decoded := members(t, archive)
	expected := []struct {
		mode uint32
		name string
	}{
		{cpioRegular | 0o500, "init"},
		{cpioDirectory | 0o700, "etc"},
		{cpioDirectory | 0o700, "etc/nessie"},
		{cpioRegular | 0o400, "etc/nessie/bootstrap-token"},
	}
	if len(decoded) != len(expected) {
		t.Fatalf("unexpected archive %#v", decoded)
	}
	for index, want := range expected {
		if decoded[index].Name != want.name || decoded[index].Mode != want.mode {
			t.Fatalf("member %d is %q mode %o", index, decoded[index].Name, decoded[index].Mode)
		}
	}
	if decoded[0].Payload != "guest-init" || decoded[3].Payload != testToken {
		t.Fatal("archive payloads do not match their sources")
	}
}

func TestInitrdIsByteIdenticalForIdenticalInputs(t *testing.T) {
	initPath, session := stageBuilder(t)
	digests := make([]string, 2)
	for index := range digests {
		output := filepath.Join(session, "initrd-"+string(rune('a'+index)))
		if err := run([]string{
			"--output", output, "--init", initPath, "--bootstrap-token-stdin",
		}, strings.NewReader(testToken)); err != nil {
			t.Fatal(err)
		}
		archive, err := os.ReadFile(output)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(archive)
		digests[index] = hex.EncodeToString(sum[:])
	}
	if digests[0] != digests[1] {
		t.Fatalf("the builder is not deterministic: %s vs %s", digests[0], digests[1])
	}
}

func TestInitrdRefusesEverythingThatIsNotAOneUseSessionArtifact(t *testing.T) {
	initPath, session := stageBuilder(t)
	valid := []string{"--output", filepath.Join(session, "ok"), "--init", initPath, "--bootstrap-token-stdin"}
	if err := run(valid, strings.NewReader(testToken)); err != nil {
		t.Fatal(err)
	}
	// An existing output is never overwritten: an initrd is one-use material.
	if err := run(valid, strings.NewReader(testToken)); err == nil {
		t.Fatal("overwrote an existing initrd")
	}
	for _, argv := range [][]string{
		{"--output", "relative", "--bootstrap-token-stdin"},
		{"--output", filepath.Join(session, "a"), "--init", initPath},
		{"--bootstrap-token-stdin"},
		{"--output", filepath.Join(session, "a"), "--unknown", "x", "--bootstrap-token-stdin"},
	} {
		if err := run(argv, strings.NewReader(testToken)); err == nil {
			t.Fatalf("accepted argv %#v", argv)
		}
	}
	for _, token := range []string{
		"",
		"short",
		strings.Repeat("A", 44),
		// 43 characters that are not a canonical 32-byte base64url encoding.
		strings.Repeat("A", 42) + "B",
		strings.Repeat("!", 43),
	} {
		err := run([]string{
			"--output", filepath.Join(session, "token-"+base64.RawURLEncoding.EncodeToString([]byte(token))),
			"--init", initPath, "--bootstrap-token-stdin",
		}, strings.NewReader(token))
		if err == nil {
			t.Fatalf("accepted the bootstrap token %q", token)
		}
		if strings.Contains(err.Error(), token) && token != "" {
			t.Fatal("a refusal must never echo the token")
		}
	}
	// A parent anyone else can enter is not a home for session material.
	shared := filepath.Join(t.TempDir(), "shared")
	if err := os.Mkdir(shared, 0o755); err != nil {
		t.Fatal(err)
	}
	err := run([]string{
		"--output", filepath.Join(shared, "initrd"), "--init", initPath, "--bootstrap-token-stdin",
	}, strings.NewReader(testToken))
	if err == nil {
		t.Fatal("wrote an initrd into a shared directory")
	}
}

func TestInitrdCarriesAnOwnerPrivateCodexProfileWhenAsked(t *testing.T) {
	initPath, session := stageBuilder(t)
	profile := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(profile, []byte(`{"token":"x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(session, "guest-initrd")
	if err := run([]string{
		"--output", output, "--init", initPath, "--codex-auth", profile, "--bootstrap-token-stdin",
	}, strings.NewReader(testToken)); err != nil {
		t.Fatal(err)
	}
	archive, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	decoded := members(t, archive)
	last := decoded[len(decoded)-1]
	if last.Name != "etc/nessie/codex-auth.json" || last.Mode != cpioRegular|0o400 || last.Payload != `{"token":"x"}` {
		t.Fatalf("unexpected codex member %#v", last)
	}
	// A world-readable login profile is refused rather than copied.
	shared := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(shared, []byte(`{"token":"x"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{
		"--output", filepath.Join(session, "second"), "--init", initPath,
		"--codex-auth", shared, "--bootstrap-token-stdin",
	}, strings.NewReader(testToken)); err == nil {
		t.Fatal("copied a shared Codex auth profile into a guest")
	}
}
