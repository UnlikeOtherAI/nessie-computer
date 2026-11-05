package main

import (
	"encoding/json"
	"os"
	"testing"
)

// The one artifact both sides of the draft protocol are asserted against. The
// guest produces these exact bytes and executor/test/guest-draft-ingest.test.ts
// parses the same file, so a change to either encoder or validator that the
// other did not agree to fails a test rather than a boot.
const draftGoldenPath = "../test/fixtures/guest-draft-scan.json"
const draftChunkGoldenPath = "../test/fixtures/guest-draft-chunk.json"

func goldenScan() draftScanResult {
	next := 4
	return draftScanResult{
		Entries: []draftEntry{
			{Kind: "dir", Mode: 0o700, Path: "src"},
			{Kind: "file", Mode: 0o600, Path: "src/main.ts", Size: 23},
			{Kind: "dir", Mode: 0o755, Opaque: true, Path: "build"},
			{Kind: "whiteout", Path: "stale.txt"},
		},
		Next:    &next,
		Version: guestRuntimeControlVersion,
	}
}

func goldenChunk() draftChunk {
	return draftChunk{Bytes: []byte("export const value = 1\n"), EOF: true, Version: guestRuntimeControlVersion}
}

func assertGolden(t *testing.T, path string, value any) {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	expected, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != string(expected) {
		t.Fatalf("guest encoding drifted from the shared fixture\n got: %s\nwant: %s", encoded, expected)
	}
}

func TestDraftScanEncodingMatchesTheSharedHostFixture(t *testing.T) {
	assertGolden(t, draftGoldenPath, goldenScan())
}

func TestDraftChunkEncodingMatchesTheSharedHostFixture(t *testing.T) {
	assertGolden(t, draftChunkGoldenPath, goldenChunk())
}

func TestDraftScanOmitsCursorOnTheFinalPage(t *testing.T) {
	final := draftScanResult{Entries: []draftEntry{}, Version: guestRuntimeControlVersion}
	encoded, err := json.Marshal(final)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"entries":[],"version":1}` {
		t.Fatalf("a final page must carry no cursor: %s", encoded)
	}
}
