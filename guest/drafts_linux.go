//go:build linux

package main

import (
	"io"
	"os"
	"path"
	"sort"
	"strings"
	"syscall"
)

// The host cannot read the draft image, so the guest reports its own overlay
// upper layer over the existing control channel. Nothing here interprets the
// workspace: an entry is a name, a kind and permission bits, and file bytes
// come back in bounded chunks the host writes through its own no-follow
// resolver. The guest never sends an absolute path and never leaves the upper
// layer.

// overlayfs marks a directory whose lower contents must be ignored. With
// `userxattr` this lives in the `user.` namespace, so an unprivileged guest
// can still read it and report a directory the workload emptied.
const overlayOpaqueXattr = "user.overlay.opaque"

type draftReader struct {
	root string
}

// Returns the interface, not the pointer: a typed nil pointer stored in an
// interface is not nil, and the controller decides on `drafts == nil`.
func newDraftReader(root string) draftSource {
	if root == "" {
		return nil
	}
	return &draftReader{root: root}
}

func isOverlayOpaque(absolute string) bool {
	value := make([]byte, 8)
	size, err := syscall.Getxattr(absolute, overlayOpaqueXattr, value)
	return err == nil && size >= 1 && value[0] == 'y'
}

// walk produces a stable pre-order listing: a directory always precedes its
// contents, so the host can create parents before what goes inside them, and
// names are sorted so two scans of an unchanged draft agree.
func (reader *draftReader) walk() ([]draftEntry, error) {
	entries := make([]draftEntry, 0, draftScanMaxEntries)
	var visit func(relative string) error
	visit = func(relative string) error {
		absolute := reader.root
		if relative != "" {
			absolute = path.Join(reader.root, relative)
		}
		names, err := os.ReadDir(absolute)
		if err != nil {
			return err
		}
		sort.Slice(names, func(left, right int) bool { return names[left].Name() < names[right].Name() })
		for _, name := range names {
			child := name.Name()
			if child == "" || strings.ContainsAny(child, "/\x00") {
				return errInvalidFrame
			}
			childRelative := child
			if relative != "" {
				childRelative = relative + "/" + child
			}
			if len(childRelative) > draftPathMaxBytes || len(entries) >= draftMaxEntries {
				return errInvalidFrame
			}
			childAbsolute := path.Join(reader.root, childRelative)
			info, err := os.Lstat(childAbsolute)
			if err != nil {
				return err
			}
			mode := uint32(info.Mode().Perm())
			switch {
			case info.IsDir():
				entries = append(entries, draftEntry{
					Kind:   "dir",
					Mode:   mode,
					Opaque: isOverlayOpaque(childAbsolute),
					Path:   childRelative,
				})
				if err := visit(childRelative); err != nil {
					return err
				}
			case info.Mode()&os.ModeCharDevice != 0:
				// overlayfs records a deletion as a 0:0 character device.
				metadata, ok := info.Sys().(*syscall.Stat_t)
				if !ok || metadata.Rdev != 0 {
					continue
				}
				entries = append(entries, draftEntry{Kind: "whiteout", Path: childRelative})
			case info.Mode().IsRegular():
				entries = append(entries, draftEntry{
					Kind: "file",
					Mode: mode,
					Path: childRelative,
					Size: info.Size(),
				})
			default:
				// Symbolic links, sockets and fifos have no promotion meaning
				// and are deliberately never reported to the host.
				continue
			}
		}
		return nil
	}
	if err := visit(""); err != nil {
		return nil, err
	}
	return entries, nil
}

func (reader *draftReader) scan(cursor int) (draftScanResult, error) {
	if cursor < 0 {
		return draftScanResult{}, errInvalidFrame
	}
	// The whole listing is rebuilt per page rather than cached: a draft is at
	// most ten thousand names, and a cached listing would go stale against a
	// workload that is still running.
	all, err := reader.walk()
	if err != nil {
		return draftScanResult{}, err
	}
	if cursor > len(all) {
		return draftScanResult{}, errInvalidFrame
	}
	end := cursor + draftScanMaxEntries
	if end > len(all) {
		end = len(all)
	}
	result := draftScanResult{Entries: all[cursor:end], Version: guestRuntimeControlVersion}
	if result.Entries == nil {
		result.Entries = []draftEntry{}
	}
	if end < len(all) {
		next := end
		result.Next = &next
	}
	return result, nil
}

// resolve refuses anything that is not a plain relative name sequence inside
// the upper layer, and re-checks every component with O_NOFOLLOW semantics by
// walking with Lstat. The host validates independently; neither side trusts
// the other's check.
func (reader *draftReader) resolve(relative string) (string, error) {
	if relative == "" || len(relative) > draftPathMaxBytes || strings.ContainsRune(relative, 0) {
		return "", errInvalidFrame
	}
	if strings.HasPrefix(relative, "/") {
		return "", errInvalidFrame
	}
	absolute := reader.root
	for _, segment := range strings.Split(relative, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", errInvalidFrame
		}
		absolute = path.Join(absolute, segment)
		info, err := os.Lstat(absolute)
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", errInvalidFrame
		}
	}
	return absolute, nil
}

func (reader *draftReader) read(relative string, offset int64, maxBytes int) (draftChunk, error) {
	if offset < 0 || maxBytes <= 0 || maxBytes > draftReadMaxBytes {
		return draftChunk{}, errInvalidFrame
	}
	absolute, err := reader.resolve(relative)
	if err != nil {
		return draftChunk{}, err
	}
	file, err := os.Open(absolute)
	if err != nil {
		return draftChunk{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return draftChunk{}, err
	}
	if !info.Mode().IsRegular() {
		return draftChunk{}, errInvalidFrame
	}
	buffer := make([]byte, maxBytes)
	count, err := file.ReadAt(buffer, offset)
	if err != nil && err != io.EOF {
		return draftChunk{}, err
	}
	return draftChunk{
		Bytes:   buffer[:count],
		EOF:     offset+int64(count) >= info.Size(),
		Version: guestRuntimeControlVersion,
	}, nil
}
