//go:build linux

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// A fake sysfs plus a directory of real ext4 images: the resolver only ever
// reads directory names from the first and superblocks from the second, which
// is exactly what /sys/block and /dev give it inside a guest.
type fakeBlockTree struct {
	builder string
	dev     string
	sys     string
}

func newFakeBlockTree(t *testing.T) *fakeBlockTree {
	t.Helper()
	builder, err := exec.LookPath("mkfs.ext4")
	if err != nil {
		builder = "/sbin/mkfs.ext4"
		if _, statErr := os.Stat(builder); statErr != nil {
			t.Skip("e2fsprogs is not installed on this machine")
		}
	}
	root := t.TempDir()
	tree := &fakeBlockTree{
		builder: builder,
		dev:     filepath.Join(root, "dev"),
		sys:     filepath.Join(root, "sys-block"),
	}
	for _, directory := range []string{tree.dev, tree.sys} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	previousSys, previousDev := guestSysBlockDirectory, guestDeviceDirectory
	guestSysBlockDirectory, guestDeviceDirectory = tree.sys, tree.dev
	t.Cleanup(func() {
		guestSysBlockDirectory, guestDeviceDirectory = previousSys, previousDev
	})
	return tree
}

// attach stages one disk: a sysfs entry the scan enumerates and, when a label
// is given, a real ext4 image at the matching device node.
func (tree *fakeBlockTree) attach(t *testing.T, name string, label string) {
	t.Helper()
	if err := os.Mkdir(filepath.Join(tree.sys, name), 0o755); err != nil {
		t.Fatal(err)
	}
	device := filepath.Join(tree.dev, name)
	if label == "" {
		if err := os.WriteFile(device, make([]byte, 4096), 0o600); err != nil {
			t.Fatal(err)
		}
		return
	}
	command := exec.Command(tree.builder, "-q", "-F", "-L", label, "-O", "^has_journal", device, "16M")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("mkfs.ext4 failed: %v %s", err, output)
	}
}

// The Hyper-V case: hv_storvsc names the disks sd*, in an order the host never
// promised, and every image must still be found.
func TestLabelResolutionFindsScsiDisksInAnyOrder(t *testing.T) {
	tree := newFakeBlockTree(t)
	tree.attach(t, "sda", "nessie-draft")
	tree.attach(t, "sdb", "nessie-runtime")
	tree.attach(t, "sdc", "nessie-work")
	for expected, device := range map[guestBlockDevice]string{
		guestBlockDevices.runtime:   filepath.Join(tree.dev, "sdb"),
		guestBlockDevices.workspace: filepath.Join(tree.dev, "sdc"),
		guestBlockDevices.draft:     filepath.Join(tree.dev, "sda"),
	} {
		resolved, err := resolveGuestBlockDevice(expected)
		if err != nil {
			t.Fatalf("%s: %v", expected.label, err)
		}
		if resolved != device {
			t.Fatalf("%s resolved to %s, not %s", expected.label, resolved, device)
		}
	}
}

// The Firecracker case is unchanged: the virtio node the attach order promised
// is the one the label picks, so the assertion and the lookup agree.
func TestLabelResolutionAgreesWithTheVirtioAttachOrder(t *testing.T) {
	tree := newFakeBlockTree(t)
	tree.attach(t, "vda", "nessie-runtime")
	tree.attach(t, "vdb", "nessie-work")
	tree.attach(t, "vdc", "nessie-draft")
	for _, expected := range []guestBlockDevice{
		guestBlockDevices.runtime,
		guestBlockDevices.workspace,
		guestBlockDevices.draft,
	} {
		resolved, err := resolveGuestBlockDevice(expected)
		if err != nil {
			t.Fatalf("%s: %v", expected.label, err)
		}
		if filepath.Base(resolved) != expected.virtioName {
			t.Fatalf("%s resolved to %s, not %s", expected.label, resolved, expected.virtioName)
		}
	}
}

// The consistency assertion: the labels are there, but on the wrong virtio
// nodes, which is exactly the host/guest disagreement the order is kept for.
func TestLabelResolutionRefusesAVirtioOrderThatContradictsTheLabels(t *testing.T) {
	tree := newFakeBlockTree(t)
	tree.attach(t, "vda", "nessie-work")
	tree.attach(t, "vdb", "nessie-runtime")
	if _, err := resolveGuestBlockDevice(guestBlockDevices.runtime); err == nil {
		t.Fatal("accepted a runtime image on the node the workspace was promised")
	}
}

func TestLabelResolutionRefusesAMissingOrDuplicatedLabel(t *testing.T) {
	tree := newFakeBlockTree(t)
	tree.attach(t, "sda", "nessie-runtime")
	tree.attach(t, "sdb", "nessie-runtime")
	if _, err := resolveGuestBlockDevice(guestBlockDevices.runtime); err == nil {
		t.Fatal("accepted two disks carrying one label")
	}
	if _, err := resolveGuestBlockDevice(guestBlockDevices.draft); err == nil {
		t.Fatal("accepted a session with no draft image at all")
	}
}

// Whatever else is attached is crossed, not fatal: a disk with no ext4
// superblock, and the kernel's own virtual devices, which are never scanned.
func TestLabelResolutionSkipsForeignAndVirtualDevices(t *testing.T) {
	tree := newFakeBlockTree(t)
	tree.attach(t, "loop0", "")
	tree.attach(t, "sr0", "")
	tree.attach(t, "sda", "")
	tree.attach(t, "sdb", "nessie-work")
	resolved, err := resolveGuestBlockDevice(guestBlockDevices.workspace)
	if err != nil {
		t.Fatal(err)
	}
	if resolved != filepath.Join(tree.dev, "sdb") {
		t.Fatalf("resolved %s", resolved)
	}
	candidates, err := guestBlockDeviceCandidates()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range candidates {
		if name == "loop0" || name == "sr0" {
			t.Fatalf("%s must never be opened by the scan", name)
		}
	}
}
