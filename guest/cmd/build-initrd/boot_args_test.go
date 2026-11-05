package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Hyper-V's generation 2 firmware supplies no UEFI load options, so a session's
// own kernel arguments — its runtime-manifest digest above all — travel in the
// initrd beside the one-use token. The guest joins them onto the built-in line
// when that line says `nessie.args=initrd`.
func TestInitrdCarriesThePerSessionKernelArgumentsWhenAsked(t *testing.T) {
	initPath, session := stageBuilder(t)
	output := filepath.Join(session, "guest-initrd")
	arguments := "nessie.runtime_manifest=sha256:" + strings.Repeat("a", 64) + " nessie.egress=1"
	if err := run([]string{
		"--output", output, "--init", initPath, "--boot-args", arguments, "--bootstrap-token-stdin",
	}, strings.NewReader(testToken)); err != nil {
		t.Fatal(err)
	}
	archive, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, member := range members(t, archive) {
		if member.Name != "etc/nessie/boot-args" {
			continue
		}
		found = true
		if member.Mode != cpioRegular|0o400 {
			t.Fatalf("boot arguments are readable by more than the owner: %o", member.Mode)
		}
		if member.Payload != arguments {
			t.Fatalf("boot arguments were rewritten: %q", member.Payload)
		}
	}
	if !found {
		t.Fatal("the initrd carries no boot arguments")
	}
}

// A boot-args member appears only when the host asks for one, so the
// Firecracker archive — where the host writes the real command line — is
// byte-identical to the one that shipped.
func TestInitrdOmitsBootArgumentsByDefault(t *testing.T) {
	initPath, session := stageBuilder(t)
	output := filepath.Join(session, "guest-initrd")
	if err := run([]string{
		"--output", output, "--init", initPath, "--bootstrap-token-stdin",
	}, strings.NewReader(testToken)); err != nil {
		t.Fatal(err)
	}
	archive, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range members(t, archive) {
		if member.Name == "etc/nessie/boot-args" {
			t.Fatal("an unasked-for boot-args member appeared")
		}
	}
}

// The value becomes a kernel command line, so anything that is not printable
// single-line ASCII is refused instead of written.
func TestInitrdRefusesUnprintableOrOversizedBootArguments(t *testing.T) {
	initPath, session := stageBuilder(t)
	for name, arguments := range map[string]string{
		"empty":     "",
		"newline":   "nessie.egress=1\nrdinit=/evil",
		"nul":       "nessie.egress=1\x00",
		"oversized": strings.Repeat("a", 513),
		"nonAscii":  "nessie.note=café",
	} {
		if err := run([]string{
			"--output", filepath.Join(session, name), "--init", initPath,
			"--boot-args", arguments, "--bootstrap-token-stdin",
		}, strings.NewReader(testToken)); err == nil {
			t.Fatalf("%s boot arguments were accepted", name)
		}
	}
}
