package main

// The workspace-draft wire contract. It is stated here, outside the Linux
// build, because the control-request decoder shares this package with the
// non-Linux builds of the guest sources; only the reader that walks a real
// overlay upper layer is Linux-only.
//
// A draft entry is deliberately tiny: a relative name, what kind of thing it
// is, and permission bits. Ownership is not sent — the host applies its own,
// because the host account owns the workspace and the guest's uid is derived
// from it, not the other way round.
const (
	draftScanMaxEntries = 64
	draftReadMaxBytes   = 16_384
	draftPathMaxBytes   = 1_024
	draftMaxEntries     = 10_000
)

type draftEntry struct {
	Kind string `json:"kind"`
	Mode uint32 `json:"mode"`
	// Set on a directory overlayfs marked opaque: the workload emptied it, so
	// the host must drop whatever it still holds there before applying the
	// entries that follow. Without this a `rm -rf dir` would leave the removed
	// children in the host's overlay and the review would not show them gone.
	Opaque bool   `json:"opaque,omitempty"`
	Path   string `json:"path"`
	Size   int64  `json:"size"`
}

type draftScanResult struct {
	Entries []draftEntry `json:"entries"`
	Next    *int         `json:"next,omitempty"`
	Version int          `json:"version"`
}

type draftChunk struct {
	Bytes   []byte `json:"bytes"`
	EOF     bool   `json:"eof"`
	Version int    `json:"version"`
}

type draftSource interface {
	read(relative string, offset int64, maxBytes int) (draftChunk, error)
	scan(cursor int) (draftScanResult, error)
}
