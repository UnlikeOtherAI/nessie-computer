//go:build linux

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestShareStrategyIsStructuralAndDefaultsToVirtiofs(t *testing.T) {
	if !blockSharesRequested("console=ttyS0 rdinit=/init nessie.shares=block") {
		t.Fatal("expected the explicit block-share flag to be read")
	}
	// Absent means virtiofs, which is what keeps the macOS boot contract
	// byte-identical: its helper sets no such flag.
	if blockSharesRequested("console=hvc0 rdinit=/init nessie.workspace=1") {
		t.Fatal("a boot with no share flag must keep the virtiofs strategy")
	}
	if blockSharesRequested("console=ttyS0 nessie.shares=blockish") {
		t.Fatal("accepted a lookalike share flag")
	}
	if blockSharesRequested("console=ttyS0 nessie.shares=virtiofs") {
		t.Fatal("the virtiofs value must not select block shares")
	}
}

// The host halves of this contract are GUEST_BLOCK_DEVICE_ORDER in
// executor/src/firecracker/layout.ts and GUEST_SCSI_ATTACH_ORDER in
// executor/src/hyperv/layout.ts. The labels are what the guest actually looks
// up (see mounts_label_linux_test.go); the virtio names stay the assertion.
func TestBlockDeviceOrderAndLabelsMatchTheHostAttachOrder(t *testing.T) {
	ordered := []guestBlockDevice{
		guestBlockDevices.runtime,
		guestBlockDevices.workspace,
		guestBlockDevices.draft,
	}
	expectedDevices := []string{"vda", "vdb", "vdc"}
	expectedLabels := []string{"nessie-runtime", "nessie-work", "nessie-draft"}
	for index, device := range ordered {
		if device.virtioName != expectedDevices[index] || device.label != expectedLabels[index] {
			t.Fatalf("device %d is %#v, not %s/%s", index, device, expectedDevices[index], expectedLabels[index])
		}
	}
}

// ext4Label is what turns the attach order from an assumption into a checked
// fact, so it is exercised against a filesystem mke2fs actually wrote.
func TestExt4LabelReadsARealSuperblockAndRefusesAnythingElse(t *testing.T) {
	builder, err := exec.LookPath("mkfs.ext4")
	if err != nil {
		builder = "/sbin/mkfs.ext4"
		if _, statErr := os.Stat(builder); statErr != nil {
			t.Skip("e2fsprogs is not installed on this machine")
		}
	}
	image := filepath.Join(t.TempDir(), "draft.img")
	command := exec.Command(builder, "-q", "-F", "-L", "nessie-draft", "-O", "^has_journal", image, "16M")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("mkfs.ext4 failed: %v %s", err, output)
	}
	label, err := ext4Label(image)
	if err != nil {
		t.Fatal(err)
	}
	if label != "nessie-draft" {
		t.Fatalf("read label %q", label)
	}
	notAFilesystem := filepath.Join(t.TempDir(), "empty.img")
	if err := os.WriteFile(notAFilesystem, make([]byte, 4096), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ext4Label(notAFilesystem); err == nil {
		t.Fatal("accepted a file with no ext4 superblock")
	}
}
