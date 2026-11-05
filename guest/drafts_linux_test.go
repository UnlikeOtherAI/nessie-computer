//go:build linux

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func stageDraftUpper(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src", "deep"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("# paired\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "main.ts"), []byte("export const value = 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "deep", "note.txt"), []byte("deep"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestDraftWalkIsPreOrderSortedAndSkipsLinks(t *testing.T) {
	reader := newDraftReader(stageDraftUpper(t))
	scan, err := reader.scan(0)
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, entry := range scan.Entries {
		paths = append(paths, entry.Kind+":"+entry.Path)
	}
	// A parent always precedes its contents, names are sorted, and the
	// symbolic link is never reported: it has no promotion meaning and would
	// be a redirection the host would then have to reason about.
	expected := []string{
		"file:README.md",
		"dir:src",
		"dir:src/deep",
		"file:src/deep/note.txt",
		"file:src/main.ts",
	}
	if len(paths) != len(expected) {
		t.Fatalf("unexpected listing %#v", paths)
	}
	for index, value := range expected {
		if paths[index] != value {
			t.Fatalf("entry %d is %q, not %q", index, paths[index], value)
		}
	}
	if scan.Next != nil {
		t.Fatal("a listing that fits one page must carry no cursor")
	}
	if scan.Version != guestRuntimeControlVersion {
		t.Fatal("a scan must carry the protocol version")
	}
}

func TestDraftScanPagesAndRefusesAnOutOfRangeCursor(t *testing.T) {
	root := t.TempDir()
	for index := 0; index < draftScanMaxEntries+3; index++ {
		name := filepath.Join(root, string(rune('a'+index%26))+string(rune('a'+index/26))+".txt")
		if err := os.WriteFile(name, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	reader := newDraftReader(root)
	first, err := reader.scan(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Entries) != draftScanMaxEntries || first.Next == nil || *first.Next != draftScanMaxEntries {
		t.Fatalf("unexpected first page %d %#v", len(first.Entries), first.Next)
	}
	second, err := reader.scan(*first.Next)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Entries) != 3 || second.Next != nil {
		t.Fatalf("unexpected final page %d %#v", len(second.Entries), second.Next)
	}
	if _, err := reader.scan(-1); err == nil {
		t.Fatal("accepted a negative cursor")
	}
	if _, err := reader.scan(10_000); err == nil {
		t.Fatal("accepted a cursor past the listing")
	}
}

func TestDraftReadIsBoundedAndNeverLeavesTheUpperLayer(t *testing.T) {
	root := stageDraftUpper(t)
	reader := newDraftReader(root)
	chunk, err := reader.read("src/main.ts", 0, draftReadMaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	if string(chunk.Bytes) != "export const value = 1\n" || !chunk.EOF {
		t.Fatalf("unexpected chunk %#v", chunk)
	}
	partial, err := reader.read("src/main.ts", 0, 6)
	if err != nil {
		t.Fatal(err)
	}
	if string(partial.Bytes) != "export" || partial.EOF {
		t.Fatalf("unexpected partial chunk %#v", partial)
	}
	tail, err := reader.read("src/main.ts", 6, draftReadMaxBytes)
	if err != nil || !tail.EOF {
		t.Fatalf("unexpected tail %#v %v", tail, err)
	}
	for _, refused := range []string{
		"../etc/passwd",
		"/etc/passwd",
		"src/../../etc/passwd",
		"escape",
		"src/./main.ts",
		"",
	} {
		if _, err := reader.read(refused, 0, draftReadMaxBytes); err == nil {
			t.Fatalf("accepted the draft path %q", refused)
		}
	}
	if _, err := reader.read("src", 0, draftReadMaxBytes); err == nil {
		t.Fatal("accepted a directory as a draft file")
	}
	if _, err := reader.read("src/main.ts", 0, draftReadMaxBytes+1); err == nil {
		t.Fatal("accepted an oversized draft read")
	}
	if _, err := reader.read("src/main.ts", -1, draftReadMaxBytes); err == nil {
		t.Fatal("accepted a negative draft offset")
	}
}

func TestDraftOperationsAreUnavailableWithoutADraftLayer(t *testing.T) {
	if newDraftReader("") != nil {
		t.Fatal("a virtiofs session must expose no draft reader at all")
	}
	controller := newRuntimeController(nil, nil)
	if controller != nil {
		t.Fatal("a session with neither runtime nor draft has no controller")
	}
	withDraft := newRuntimeController(nil, newDraftReader(t.TempDir()))
	if withDraft == nil || withDraft.drafts == nil || withDraft.browser != nil {
		t.Fatal("a workspace-only session must expose drafts and nothing else")
	}
	response := handleRuntimeControlRequest(
		[]byte(`{"cursor":0,"operation":"workspace.draft_scan","version":1}`), withDraft)
	if string(response) != `{"entries":[],"version":1}` {
		t.Fatalf("unexpected empty draft scan %s", response)
	}
}

func TestDraftControlRequestsRefuseForeignFields(t *testing.T) {
	for _, payload := range []string{
		`{"cursor":0,"operation":"workspace.draft_scan","path":"a","version":1}`,
		`{"cursor":-1,"operation":"workspace.draft_scan","version":1}`,
		`{"maxResultBytes":16384,"offset":0,"operation":"workspace.draft_read","version":1}`,
		`{"cursor":1,"maxResultBytes":16384,"offset":0,"operation":"workspace.draft_read","path":"a","version":1}`,
		`{"maxResultBytes":99999,"offset":0,"operation":"workspace.draft_read","path":"a","version":1}`,
		`{"maxResultBytes":16384,"offset":-1,"operation":"workspace.draft_read","path":"a","version":1}`,
		// The draft fields belong to nothing else.
		`{"cursor":3,"operation":"runtime.inspect","version":1}`,
		`{"offset":3,"operation":"runtime.inspect","version":1}`,
		`{"operation":"runtime.inspect","path":"a","version":1}`,
	} {
		if _, err := decodeRuntimeControlRequest([]byte(payload)); err == nil {
			t.Fatalf("accepted %s", payload)
		}
	}
}
