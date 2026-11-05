package main

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestCodingRuntimeUsesCredentialFreeCOWProfile(t *testing.T) {
	root := t.TempDir()
	profile := filepath.Join(root, ".nessie-executor", "coding", "claude")
	var actualArgs, actualEnvironment []string
	runtime := &codingRuntime{
		agentExecutables: map[codingAgent]string{codingAgentClaude: "/runtime/bin/claude"},
		profileRoot:      root,
		run: func(_ string, args, environment []string) ([]byte, error) {
			actualArgs = append([]string{}, args...)
			actualEnvironment = append([]string{}, environment...)
			return nil, nil
		},
		socket: filepath.Join(root, "tmux.sock"),
		tmux:   "/runtime/bin/tmux",
	}
	if err := runtime.launch(codingAgentClaude, "task"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actualArgs, []string{
		"-f", codingConfigPath,
		"-S", runtime.socket,
		"new-session", "-d", "-s", codingSessionName, "--",
		"/runtime/bin/claude",
	}) {
		t.Fatalf("unexpected Claude launch %#v", actualArgs)
	}
	if !reflect.DeepEqual(actualEnvironment, codingEnvironment(codingAgentClaude, profile)) {
		t.Fatalf("unexpected Claude environment %#v", actualEnvironment)
	}
	joined := strings.Join(actualEnvironment, "\x00")
	if strings.Contains(joined, "ANTHROPIC_API_KEY=") || strings.Contains(joined, "NESSIE_EXECUTOR_SESSION_PROOF=") {
		t.Fatal("Claude launch received a credential or broker proof")
	}
}
