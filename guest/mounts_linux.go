//go:build linux

package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

// One guest binary, two share strategies. macOS gives it virtiofs devices;
// Firecracker and Hyper-V implement no virtio-fs at all, so there the same
// shares arrive as virtio-block images. Which one is in force is a structural
// fact on the kernel command line the host wrote (`nessie.shares=block`),
// never a probe: a guest that guessed would mount whatever happened to exist.
//
// # BLOCK DEVICE DISCOVERY CONTRACT
//
// The label decides; the order only proves.
//
// Under Firecracker the three images arrive on virtio-block and appear in the
// guest in the order the host attached them, so runtime, workspace and draft
// are /dev/vda, /dev/vdb and /dev/vdc. Under Hyper-V the same three images
// arrive on a synthetic SCSI controller through hv_storvsc, are named /dev/sd*,
// and Linux hands out those names as each disk finishes probing rather than in
// the order the host attached them. A guest that read a device name out of the
// attach order would therefore mount the wrong image on Windows, and only
// sometimes on Linux — that ordering has been an upstream bug before
// (firecracker#1264, device-tree insertion order on aarch64).
//
// So the guest finds each image by scanning the host's own block devices
// (/sys/block) and reading the ext4 volume label straight out of each
// superblock. Where the bus does promise attach order — virtio — the expected
// node is kept as a consistency assertion: if it exists at all it must be the
// one the label picked, which is what catches the host and the guest
// disagreeing. The host halves of this contract are `GUEST_BLOCK_DEVICE_ORDER`
// in executor/src/firecracker/layout.ts and `GUEST_SCSI_ATTACH_ORDER` in
// executor/src/hyperv/layout.ts.
const (
	guestRuntimeMountPoint   = "/runtime"
	guestWorkspaceMountPoint = "/work"
	guestLowerMountPoint     = "/lower"
	guestDraftMountPoint     = "/draft"
	guestDraftUpperPath      = "/draft/upper"
	guestDraftWorkPath       = "/draft/work"

	guestVirtiofsWorkspaceTag = "nessie-cow"
	guestVirtiofsRuntimeTag   = "nessie-runtime"

	ext4SuperblockOffset = 1024
	ext4MagicOffset      = 0x38
	ext4LabelOffset      = 0x78
	ext4LabelBytes       = 16
	ext4Magic            = 0xEF53
)

// guestBlockDevice names one image by its ext4 label plus the bare device node
// the virtio attach order promises. `virtioName` is an assertion, never the
// lookup: hv_storvsc makes no such promise, so it is only checked when that
// node exists.
type guestBlockDevice struct {
	label      string
	virtioName string
}

var guestBlockDevices = struct {
	runtime   guestBlockDevice
	workspace guestBlockDevice
	draft     guestBlockDevice
}{
	runtime:   guestBlockDevice{label: "nessie-runtime", virtioName: "vda"},
	workspace: guestBlockDevice{label: "nessie-work", virtioName: "vdb"},
	draft:     guestBlockDevice{label: "nessie-draft", virtioName: "vdc"},
}

// Overridden only by the tests, which stand a fake sysfs and a directory of
// real mke2fs images in for the two trees the guest reads at boot.
var (
	guestSysBlockDirectory = "/sys/block"
	guestDeviceDirectory   = "/dev"
)

// Never one of our images: the kernel's own virtual block devices, and optical
// devices, whose open blocks on an empty tray and which carry no ext4
// superblock to read.
var guestBlockDeviceSkipPrefixes = []string{"loop", "ram", "dm-", "sr", "md", "zram", "nbd"}

// guestShares records what a boot actually mounted. `draftRoot` is empty under
// virtiofs, where the guest writes straight through to the host's own overlay
// directory and there is nothing to stream back.
type guestShares struct {
	draftRoot         string
	workspaceAttached bool
}

func mountProc() error {
	if err := os.Mkdir("/proc", 0o555); err != nil && !os.IsExist(err) {
		return err
	}
	err := syscall.Mount("proc", "/proc", "proc", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, "")
	if err != nil && err != syscall.EBUSY {
		return err
	}
	return nil
}

// CONFIG_DEVTMPFS_MOUNT does not apply to an initramfs, so the block device
// nodes exist only once the guest mounts /dev itself.
func mountDev() error {
	if err := os.Mkdir("/dev", 0o755); err != nil && !os.IsExist(err) {
		return err
	}
	err := syscall.Mount("devtmpfs", "/dev", "devtmpfs", syscall.MS_NOSUID|syscall.MS_NOEXEC, "")
	if err != nil && err != syscall.EBUSY {
		return err
	}
	return nil
}

// ext4Label reads the volume name straight out of the superblock. The guest has
// no blkid, no udev and no shell, and this is 16 bytes at a fixed offset.
func ext4Label(device string) (string, error) {
	file, err := os.Open(device)
	if err != nil {
		return "", err
	}
	defer file.Close()
	header := make([]byte, ext4SuperblockOffset+ext4LabelOffset+ext4LabelBytes)
	if _, err := io.ReadFull(file, header); err != nil {
		return "", err
	}
	if binary.LittleEndian.Uint16(header[ext4SuperblockOffset+ext4MagicOffset:]) != ext4Magic {
		return "", errInvalidFrame
	}
	raw := header[ext4SuperblockOffset+ext4LabelOffset : ext4SuperblockOffset+ext4LabelOffset+ext4LabelBytes]
	if end := bytes.IndexByte(raw, 0); end >= 0 {
		raw = raw[:end]
	}
	return string(raw), nil
}

func guestBlockDeviceCandidates() ([]string, error) {
	entries, err := os.ReadDir(guestSysBlockDirectory)
	if err != nil {
		return nil, err
	}
	candidates := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		skip := false
		for _, prefix := range guestBlockDeviceSkipPrefixes {
			if strings.HasPrefix(name, prefix) {
				skip = true
				break
			}
		}
		if !skip {
			candidates = append(candidates, name)
		}
	}
	sort.Strings(candidates)
	return candidates, nil
}

// resolveGuestBlockDevice finds the one attached disk whose ext4 superblock
// carries expected.label. A device that cannot be opened or read is skipped
// rather than fatal — the scan crosses whatever else the host attached — but a
// label no disk carries, or two disks claiming one label, is refused: the first
// means the host staged the wrong session and the second means it staged two,
// and neither is a thing to guess about.
func resolveGuestBlockDevice(expected guestBlockDevice) (string, error) {
	candidates, err := guestBlockDeviceCandidates()
	if err != nil {
		return "", err
	}
	resolved := ""
	for _, name := range candidates {
		device := filepath.Join(guestDeviceDirectory, name)
		label, labelErr := ext4Label(device)
		if labelErr != nil || label != expected.label {
			continue
		}
		if resolved != "" {
			return "", errInvalidFrame
		}
		resolved = device
	}
	if resolved == "" {
		return "", errInvalidFrame
	}
	// The order assertion, kept only where the bus makes the promise: if the
	// node the virtio attach order named exists at all, it must be this one.
	if expected.virtioName != "" && filepath.Base(resolved) != expected.virtioName {
		if _, statErr := os.Stat(filepath.Join(guestDeviceDirectory, expected.virtioName)); statErr == nil {
			return "", errInvalidFrame
		}
	}
	return resolved, nil
}

func mountGuestRuntime(commandLine string) error {
	if err := os.Mkdir(guestRuntimeMountPoint, 0o755); err != nil && !os.IsExist(err) {
		return err
	}
	// The runtime is the one mount that is deliberately executable: a noexec
	// runtime would make a browser, tmux or CLI impossible.
	flags := uintptr(syscall.MS_RDONLY | syscall.MS_NOSUID | syscall.MS_NODEV)
	if blockSharesRequested(commandLine) {
		device, err := resolveGuestBlockDevice(guestBlockDevices.runtime)
		if err != nil {
			return err
		}
		return syscall.Mount(device, guestRuntimeMountPoint, "ext4", flags, "")
	}
	return syscall.Mount(guestVirtiofsRuntimeTag, guestRuntimeMountPoint, "virtiofs", flags, "")
}

// The workspace is writable from inside the guest and never executable, so a
// workspace edit can never become guest execution.
const guestWorkspaceMountFlags = syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_NOEXEC

func mountGuestWorkspaceVirtiofs() (guestShares, error) {
	if err := os.Mkdir(guestWorkspaceMountPoint, 0o700); err != nil && !os.IsExist(err) {
		return guestShares{workspaceAttached: true}, err
	}
	err := syscall.Mount(
		guestVirtiofsWorkspaceTag, guestWorkspaceMountPoint, "virtiofs", guestWorkspaceMountFlags, "")
	return guestShares{workspaceAttached: true}, err
}

// mountGuestWorkspaceBlock layers the run's read-only snapshot under a writable
// draft image. Paths inside the guest are identical to the virtiofs strategy —
// the workload only ever sees /work — but every edit lands in the draft's upper
// layer, which the host later streams back over the control channel.
//
// `userxattr` puts overlayfs's own markers in the `user.` namespace instead of
// `trusted.`, which needs CAP_SYS_ADMIN to read. That is what lets the guest
// still report an emptied directory after it has dropped privileges. It
// requires Linux 5.11 or newer; the packaged guest kernel is 6.1.
func mountGuestWorkspaceBlock() (guestShares, error) {
	attached := guestShares{workspaceAttached: true}
	lower, err := resolveGuestBlockDevice(guestBlockDevices.workspace)
	if err != nil {
		return attached, err
	}
	draft, err := resolveGuestBlockDevice(guestBlockDevices.draft)
	if err != nil {
		return attached, err
	}
	for _, directory := range []string{guestLowerMountPoint, guestDraftMountPoint, guestWorkspaceMountPoint} {
		if err := os.Mkdir(directory, 0o700); err != nil && !os.IsExist(err) {
			return attached, err
		}
	}
	if err := syscall.Mount(
		lower, guestLowerMountPoint, "ext4", guestWorkspaceMountFlags|syscall.MS_RDONLY, ""); err != nil {
		return attached, err
	}
	if err := syscall.Mount(draft, guestDraftMountPoint, "ext4", guestWorkspaceMountFlags, ""); err != nil {
		return attached, err
	}
	// The merged root takes its owner from the upper layer, and that owner is
	// what the guest drops privileges to. The draft image's own root carries
	// the identity the host built it with, so the overlay layers inherit it
	// rather than staying root-owned — a root-owned workspace fails boot.
	info, err := os.Stat(guestDraftMountPoint)
	if err != nil {
		return attached, err
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return attached, errInvalidFrame
	}
	for _, directory := range []string{guestDraftUpperPath, guestDraftWorkPath} {
		if err := os.Mkdir(directory, 0o700); err != nil && !os.IsExist(err) {
			return attached, err
		}
		if err := os.Chown(directory, int(metadata.Uid), int(metadata.Gid)); err != nil {
			return attached, err
		}
	}
	options := "lowerdir=" + guestLowerMountPoint +
		",upperdir=" + guestDraftUpperPath +
		",workdir=" + guestDraftWorkPath +
		",userxattr"
	if err := syscall.Mount(
		"overlay", guestWorkspaceMountPoint, "overlay", guestWorkspaceMountFlags, options); err != nil {
		return attached, err
	}
	attached.draftRoot = guestDraftUpperPath
	return attached, nil
}

// mountGuestShares performs every boot mount the host asked for, in the one
// order that works: /proc first (the command line is read from it), then the
// device nodes the block strategy needs, then the workspace, then the runtime.
func mountGuestShares(commandLine string) (guestShares, *runtimeManifest, error) {
	block := blockSharesRequested(commandLine)
	if block {
		if err := mountDev(); err != nil {
			return guestShares{}, nil, err
		}
	}
	var shares guestShares
	if workspaceRequested(commandLine) {
		var err error
		if block {
			shares, err = mountGuestWorkspaceBlock()
		} else {
			shares, err = mountGuestWorkspaceVirtiofs()
		}
		if err != nil {
			return shares, nil, err
		}
	}
	if !runtimeRequested(commandLine) {
		return shares, nil, nil
	}
	manifestDigest, ok := runtimeManifestDigest(commandLine)
	if !ok {
		return shares, nil, errInvalidFrame
	}
	if err := mountGuestRuntime(commandLine); err != nil {
		return shares, nil, err
	}
	manifest, err := verifyMountedGuestRuntime(manifestDigest)
	if err != nil {
		return shares, nil, err
	}
	return shares, &manifest, nil
}
