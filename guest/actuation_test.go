package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCommandRuntimeAcceptsOnlyShellFreeWorkspaceArgv(t *testing.T) {
	valid := commandRequest{
		Args:           []string{"test"},
		CWD:            "packages/runtime",
		MaxResultBytes: 8 * 1024,
		Program:        "pnpm",
		RuntimeSeconds: 30,
	}
	if !validCommandRequest(valid) {
		t.Fatal("rejected a valid argv command")
	}
	for _, request := range []commandRequest{
		{Args: []string{"-c", "id"}, MaxResultBytes: 8 * 1024, Program: "sh", RuntimeSeconds: 30},
		{Args: []string{}, CWD: "../outside", MaxResultBytes: 8 * 1024, Program: "pnpm", RuntimeSeconds: 30},
		{Args: []string{}, MaxResultBytes: 8 * 1024, Program: "/bin/sh", RuntimeSeconds: 30},
	} {
		if validCommandRequest(request) {
			t.Fatalf("accepted unsafe command %#v", request)
		}
	}

	called := false
	runtime := &commandRuntime{
		codex:    "/runtime/bin/codex",
		prepared: true,
		run: func(path string, request commandRequest) (commandResult, error) {
			called = true
			if path != "/runtime/bin/codex" || request.Program != "pnpm" || len(request.Args) != 1 || request.Args[0] != "test" {
				t.Fatalf("unexpected direct argv execution %q %#v", path, request)
			}
			return commandResult{ExitCode: 0, Output: "passed", Success: true}, nil
		},
	}
	result, err := runtime.execute(valid)
	if err != nil || !called || result != (commandResult{ExitCode: 0, Output: "passed", Success: true}) {
		t.Fatalf("unexpected command result %#v %v", result, err)
	}
}

func TestCommandOutputFailsClosedAtItsByteLimit(t *testing.T) {
	output := &boundedCommandOutput{maximum: 4}
	if _, err := output.Write([]byte("safe")); err != nil || output.overflowed {
		t.Fatal("rejected bounded command output")
	}
	if _, err := output.Write([]byte("!")); err == nil || !output.overflowed {
		t.Fatal("accepted command output beyond the byte cap")
	}
}

func TestBrowserObservationPrioritizesAccessibilityWithinTheControlCap(t *testing.T) {
	nodes := make([]browserAXNode, 0, maxBrowserAXNodes)
	for index := 0; index < maxBrowserAXNodes; index++ {
		nodes = append(nodes, browserAXNode{
			Name:   strings.Repeat("n", maxBrowserAXNodeTextBytes),
			NodeID: index + 1,
			Role:   "button",
		})
	}
	observation, err := boundedBrowserObservation(
		[]browserTarget{{Title: "Guide", Type: "page", URL: "https://app.example.test/guide"}},
		nodes,
		&browserScreenshot{DataBase64: strings.Repeat("A", maxBrowserScreenshotBytes), MIME: "image/webp"},
	)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(observation)
	if err != nil || len(encoded) > maxBrowserObserveBytes {
		t.Fatalf("browser observation exceeded its control cap: %d %v", len(encoded), err)
	}
	if len(observation.AccessibilityTree) == 0 {
		t.Fatal("browser observation dropped its accessibility tree before optional data")
	}
}

func TestBrowserActionRequiresAFreshObservedNodeAfterEachMutation(t *testing.T) {
	acted := 0
	browser := &browserRuntime{
		act: func(action browserAction) (browserActionResult, error) {
			acted++
			return browserActionResult{Status: "acted"}, nil
		},
		observedNodeIDs: map[int]struct{}{9: {}},
		process:         &fakeBrowserProcess{done: make(chan struct{})},
	}
	if _, err := browser.action(browserAction{Action: "click", NodeID: 9, HasNodeID: true}); err != nil {
		t.Fatalf("rejected fresh observed node: %v", err)
	}
	if _, err := browser.action(browserAction{Action: "click", NodeID: 9, HasNodeID: true}); err == nil {
		t.Fatal("accepted a stale node without another observation")
	}
	if acted != 1 {
		t.Fatalf("unexpected browser act count %d", acted)
	}
}
