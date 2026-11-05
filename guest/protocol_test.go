package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"
)

const testBootstrapToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func TestBootstrapTokenIsCanonical32ByteBase64URL(t *testing.T) {
	if !validBootstrapToken(testBootstrapToken) {
		t.Fatal("expected canonical token to validate")
	}
	if validBootstrapToken("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
		t.Fatal("accepted a non-canonical base64url token")
	}
}

func TestControlFramesRoundTripWithoutUnknownFields(t *testing.T) {
	original := controlEnvelope{
		Kind:      "request",
		Payload:   []byte(`{"operation":"bootstrap"}`),
		RequestID: "ab7ae325-8420-4b2a-9cee-20b07066a77d",
		Version:   guestControlVersion,
	}
	var wire bytes.Buffer
	if err := writeControlFrame(&wire, original); err != nil {
		t.Fatal(err)
	}
	actual, err := readControlFrame(&wire)
	if err != nil {
		t.Fatal(err)
	}
	if actual.Kind != original.Kind || actual.RequestID != original.RequestID || !bytes.Equal(actual.Payload, original.Payload) {
		t.Fatal("frame round trip changed control data")
	}
}

func TestControlFrameRejectsGuestTokenReuse(t *testing.T) {
	var wire bytes.Buffer
	if err := writeControlFrame(&wire, controlEnvelope{
		Kind:         "request",
		Payload:      []byte{},
		RequestID:    "ab7ae325-8420-4b2a-9cee-20b07066a77d",
		SessionToken: testBootstrapToken,
		Version:      guestControlVersion,
	}); err == nil {
		t.Fatal("accepted a bootstrap token on a normal request")
	}
}

func TestWorkspaceMustBeExplicitlyRequestedByTheHostBootCommand(t *testing.T) {
	if !workspaceRequested("console=hvc0 rdinit=/init nessie.workspace=1") {
		t.Fatal("expected explicit workspace command-line flag")
	}
	if workspaceRequested("console=hvc0 rdinit=/init nessie.workspace=10") {
		t.Fatal("accepted a lookalike workspace command-line flag")
	}
}

func TestEgressMustBeExplicitlyRequestedByTheHostBootCommand(t *testing.T) {
	if !egressRequested("console=hvc0 rdinit=/init nessie.egress=1") {
		t.Fatal("expected explicit egress command-line flag")
	}
	if egressRequested("console=hvc0 rdinit=/init nessie.egress=10") {
		t.Fatal("accepted a lookalike egress command-line flag")
	}
}

func TestRuntimeMustBeExplicitlyRequestedByTheHostBootCommand(t *testing.T) {
	if !runtimeRequested("console=hvc0 rdinit=/init nessie.runtime=1") {
		t.Fatal("expected explicit runtime command-line flag")
	}
	if runtimeRequested("console=hvc0 rdinit=/init nessie.runtime=10") {
		t.Fatal("accepted a lookalike runtime command-line flag")
	}
}

func TestGuestRuntimeRechecksTheMountedManifestAndEveryFile(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "bin"), 0o700); err != nil {
		t.Fatal(err)
	}
	browser := []byte("browser")
	if err := os.WriteFile(filepath.Join(root, "bin", "browser"), browser, 0o700); err != nil {
		t.Fatal(err)
	}
	fileHash := sha256.Sum256(browser)
	manifest := []byte(`{"entrypoints":{"browser":"bin/browser"},"files":[{"executable":true,"path":"bin/browser","sha256":"` + hex.EncodeToString(fileHash[:]) + `"}],"version":1}`)
	if err := os.WriteFile(filepath.Join(root, "nessie-guest-runtime.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	manifestHash := sha256.Sum256(manifest)
	digest := "sha256:" + hex.EncodeToString(manifestHash[:])
	if err := verifyGuestRuntime(root, digest); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "bin", "browser"), []byte("tampered"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := verifyGuestRuntime(root, digest); err == nil {
		t.Fatal("accepted a changed mounted runtime file")
	}
	if err := os.WriteFile(filepath.Join(root, "bin", "browser"), browser, 0o700); err != nil {
		t.Fatal(err)
	}
	unknownEntrypoint := []byte(`{"entrypoints":{"browser":"bin/browser","hidden":"bin/browser"},"files":[{"executable":true,"path":"bin/browser","sha256":"` + hex.EncodeToString(fileHash[:]) + `"}],"version":1}`)
	if err := os.WriteFile(filepath.Join(root, "nessie-guest-runtime.json"), unknownEntrypoint, 0o600); err != nil {
		t.Fatal(err)
	}
	unknownHash := sha256.Sum256(unknownEntrypoint)
	if err := verifyGuestRuntime(root, "sha256:"+hex.EncodeToString(unknownHash[:])); err == nil {
		t.Fatal("accepted an unknown runtime entrypoint")
	}
}

func TestGuestRuntimeInspectionExposesOnlyDeclaredCapabilityNames(t *testing.T) {
	manifest := runtimeManifest{Entrypoints: map[string]string{
		"browser": "bin/browser",
		"codex":   "bin/codex",
		"tmux":    "bin/tmux",
	}}
	controller := newRuntimeController(&manifest, nil)
	defer controller.close()
	payload := []byte(`{"operation":"runtime.inspect","version":1}`)
	response := handleRuntimeControlRequest(payload, controller)
	var decoded struct {
		Inspection runtimeInspection `json:"inspection"`
		Version    int               `json:"version"`
	}
	if err := json.Unmarshal(response, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Version != guestRuntimeControlVersion || !decoded.Inspection.Browser || !decoded.Inspection.Codex || decoded.Inspection.Tmux || decoded.Inspection.Claude {
		t.Fatalf("unexpected runtime inspection %#v", decoded)
	}
	if !bytes.Contains(handleRuntimeControlRequest([]byte(`{"operation":"browser.open","version":1}`), controller), []byte("CAPABILITY_UNAVAILABLE")) {
		t.Fatal("accepted an unimplemented runtime operation")
	}
}

type fakeBrowserProcess struct {
	done chan struct{}
}

func (process *fakeBrowserProcess) Kill() error {
	select {
	case <-process.done:
	default:
		close(process.done)
	}
	return nil
}

func (process *fakeBrowserProcess) Wait() error {
	<-process.done
	return nil
}

func TestGuestBrowserUsesOnlyTheDeclaredRuntimeEntrypointAndForcedProxy(t *testing.T) {
	profile := t.TempDir()
	process := &fakeBrowserProcess{done: make(chan struct{})}
	var actualPath string
	var actualArgs, actualEnvironment []string
	browser := &browserRuntime{
		executable:  "/runtime/bin/browser",
		profile:     filepath.Join(profile, "browser"),
		profileRoot: profile,
		launch: func(path string, args, environment []string) (browserProcess, error) {
			actualPath = path
			actualArgs = append([]string{}, args...)
			actualEnvironment = append([]string{}, environment...)
			return process, nil
		},
		observe: func(bool) (browserObservation, error) {
			return browserObservation{Targets: []browserTarget{{
				Title: "Guide", Type: "page", URL: "https://app.example.test/guide?secret=redacted",
			}}}, nil
		},
	}
	controller := &runtimeController{
		browser:  browser,
		manifest: &runtimeManifest{Entrypoints: map[string]string{"browser": "bin/browser"}},
	}
	response := handleRuntimeControlRequest([]byte(`{"operation":"browser.open","url":"https://app.example.test/guide","version":1}`), controller)
	if !bytes.Contains(response, []byte(`"status":"started"`)) {
		t.Fatalf("browser launch failed: %s", response)
	}
	if actualPath != "/runtime/bin/browser" || !reflect.DeepEqual(actualArgs, fixedBrowserArguments("https://app.example.test/guide", browser.profile)) {
		t.Fatalf("unexpected browser launch %q %#v", actualPath, actualArgs)
	}
	if !reflect.DeepEqual(actualEnvironment, browserEnvironment(browser.profile)) || strings.Contains(strings.Join(actualEnvironment, "\x00"), "PATH=") {
		t.Fatalf("browser inherited an ambient environment: %#v", actualEnvironment)
	}
	if !bytes.Contains(handleRuntimeControlRequest([]byte(`{"operation":"browser.open","url":"https://user@app.example.test/","version":1}`), controller), []byte("CAPABILITY_UNAVAILABLE")) {
		t.Fatal("accepted a credential-bearing browser URL")
	}
	observed := handleRuntimeControlRequest([]byte(`{"operation":"browser.observe","version":1}`), controller)
	var decoded struct {
		Observation browserObservation `json:"observation"`
	}
	if err := json.Unmarshal(observed, &decoded); err != nil || !reflect.DeepEqual(decoded.Observation, browserObservation{Targets: []browserTarget{{
		Title: "Guide", Type: "page", URL: "https://app.example.test/guide?secret=redacted",
	}}}) {
		t.Fatalf("unexpected browser observation %s", observed)
	}
	controller.close()
}

func TestGuestBrowserProfileRejectsASymlinkedCOWPath(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, ".nessie-executor")); err != nil {
		t.Fatal(err)
	}
	if err := secureBrowserProfile(root, filepath.Join(root, ".nessie-executor", "browser")); err == nil {
		t.Fatal("accepted a symlinked browser profile path")
	}
}

func TestGuestBrowserProfileRejectsAPreseededCOWProfile(t *testing.T) {
	root := t.TempDir()
	profile := filepath.Join(root, ".nessie-executor", "browser")
	if err := os.MkdirAll(profile, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := secureBrowserProfile(root, profile); err == nil {
		t.Fatal("accepted a preseeded browser profile")
	}
}

func TestGuestBrowserObservationDropsQueryAndCannotDialAnotherAddress(t *testing.T) {
	observed, ok := safeObservedBrowserURL("https://app.example.test/guide?secret=value#fragment")
	if !ok || observed != "https://app.example.test/guide" {
		t.Fatalf("unexpected sanitized browser URL %q", observed)
	}
	if _, err := dialBrowserDevTools(context.Background(), "tcp", "example.test:443"); err == nil {
		t.Fatal("browser observer accepted a non-loopback destination")
	}
}

func TestGuestCodingUsesOneDedicatedTmuxServerAndExactTarget(t *testing.T) {
	root := t.TempDir()
	socket := filepath.Join(root, "tmux.sock")
	var calls [][]string
	var environments [][]string
	runtime := &codingRuntime{
		agentExecutables: map[codingAgent]string{codingAgentCodex: "/runtime/bin/codex"},
		profileRoot:      root,
		run: func(path string, args, environment []string) ([]byte, error) {
			if path != "/runtime/bin/tmux" && path != "/runtime/bin/codex" {
				t.Fatalf("unexpected executable %q", path)
			}
			calls = append(calls, append([]string{}, args...))
			environments = append(environments, append([]string{}, environment...))
			for _, argument := range args {
				if argument == "display-message" {
					return []byte("0\t\n"), nil
				}
			}
			return nil, nil
		},
		socket: socket,
		tmux:   "/runtime/bin/tmux",
	}
	const prompt = "Update the project safely"
	if err := runtime.launch(codingAgentCodex, prompt); err != nil {
		t.Fatal(err)
	}
	expectedLaunch := []string{
		"-f", codingConfigPath,
		"-S", socket,
		"new-session", "-d", "-s", codingSessionName, "--", "/runtime/bin/codex",
	}
	expectedLaunch = append(expectedLaunch, codexLaunchArguments(prompt)...)
	expectedConformance := append(
		[]string{"sandbox", "-P", codingSandboxProfile},
		append(codexSandboxConfiguration(), "/init", codingConformanceProbeArgument, "/runtime/bin/codex")...,
	)
	if len(calls) != 2 || !reflect.DeepEqual(calls[0], expectedConformance) || !reflect.DeepEqual(calls[1], expectedLaunch) {
		t.Fatalf("unexpected tmux launch %#v", calls)
	}
	codexEnvironment := strings.Join(environments[1], "\x00")
	if !reflect.DeepEqual(environments[0], codingConformanceEnvironment()) || !reflect.DeepEqual(environments[1], codingEnvironment(codingAgentCodex, "")) || !strings.Contains(codexEnvironment, "PATH=/runtime/bin:/usr/bin:/bin") || !strings.Contains(codexEnvironment, "HTTP_PROXY=http://"+guestEgressProxyAddress) || !strings.Contains(codexEnvironment, "HTTPS_PROXY=http://"+guestEgressProxyAddress) || strings.Contains(codexEnvironment, "NESSIE_EXECUTOR_SESSION_PROOF=") {
		t.Fatalf("coding launch inherited an ambient environment %#v", environments[0])
	}
	observed, err := runtime.observation()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(observed, codingObservation{Agent: codingAgentCodex, Lifecycle: "running"}) {
		t.Fatalf("unexpected coding observation %#v", observed)
	}
	if len(calls) != 3 || !reflect.DeepEqual(calls[2], []string{"-S", socket, "display-message", "-p", "-t", codingTarget, "#{pane_dead}\t#{pane_dead_status}"}) {
		t.Fatalf("coding observation lost the dedicated exact target %#v", calls)
	}
	if !reflect.DeepEqual(environments[2], environments[1]) {
		t.Fatal("coding observation inherited a different environment")
	}
	if err := runtime.close(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(calls[3], []string{"-S", socket, "kill-session", "-t", codingSessionTarget}) {
		t.Fatalf("coding close lost the exact target %#v", calls[3])
	}
}

func TestGuestCodexConformanceDeniesEveryExecutorControlFileAndRequiresAnActualNetworkDenial(t *testing.T) {
	if !reflect.DeepEqual(codexSandboxConfiguration(), []string{
		"-c", "permissions." + codingSandboxProfile + ".extends=\":workspace\"",
		"-c", "permissions." + codingSandboxProfile + ".filesystem={\"" + codingControlDirectory + "\"=\"deny\"}",
		"-c", "permissions." + codingSandboxProfile + ".network.enabled=false",
	}) {
		t.Fatal("Codex child policy does not deny the whole executor control directory")
	}
	if !codingSandboxDenied(syscall.EACCES) || !codingSandboxDenied(syscall.EPERM) {
		t.Fatal("Codex conformance did not recognize sandbox network denials")
	}
	if codingSandboxDenied(syscall.ECONNREFUSED) || codingSandboxDenied(syscall.ETIMEDOUT) {
		t.Fatal("Codex conformance accepted an unavailable proxy as a sandbox denial")
	}
}

func TestGuestCodexFailsClosedWhenItsSandboxConformanceFails(t *testing.T) {
	runtime := &codingRuntime{
		agentExecutables: map[codingAgent]string{codingAgentCodex: "/runtime/bin/codex"},
		profileRoot:      t.TempDir(),
		run: func(path string, _ []string, _ []string) ([]byte, error) {
			if path == "/runtime/bin/tmux" {
				t.Fatal("started tmux after Codex sandbox conformance failed")
			}
			return nil, errInvalidFrame
		},
		socket: filepath.Join(t.TempDir(), "tmux.sock"),
		tmux:   "/runtime/bin/tmux",
	}
	if err := runtime.launch(codingAgentCodex, "task"); err == nil {
		t.Fatal("launched Codex without a passing sandbox conformance probe")
	}
}

func TestGuestCodingRefusesPreexistingDedicatedSocket(t *testing.T) {
	root := t.TempDir()
	socket := filepath.Join(root, "tmux.sock")
	if err := os.WriteFile(socket, []byte("foreign"), 0o600); err != nil {
		t.Fatal(err)
	}
	runtime := &codingRuntime{
		agentExecutables: map[codingAgent]string{codingAgentCodex: "/runtime/bin/codex"},
		profileRoot:      root,
		run: func(string, []string, []string) ([]byte, error) {
			t.Fatal("attempted to use a preexisting tmux socket")
			return nil, errInvalidFrame
		},
		socket: socket,
		tmux:   "/runtime/bin/tmux",
	}
	if err := runtime.launch(codingAgentCodex, "task"); err == nil {
		t.Fatal("accepted a preexisting tmux socket")
	}
}

func TestGuestDropsToTheCOWOwnerOrAnUnprivilegedFallback(t *testing.T) {
	withoutWorkspace, err := selectGuestIdentity(false, 0, 0)
	if err != nil || withoutWorkspace.userID != guestFallbackID || withoutWorkspace.groupID != guestFallbackID {
		t.Fatal("guest without a workspace must use the unprivileged fallback identity")
	}
	withWorkspace, err := selectGuestIdentity(true, 501, 20)
	if err != nil || withWorkspace.userID != 501 || withWorkspace.groupID != 20 {
		t.Fatal("guest must use the mounted COW owner identity")
	}
	if _, err := selectGuestIdentity(true, 0, 20); err == nil {
		t.Fatal("guest must refuse a root-owned COW workspace identity")
	}
}

func TestEgressTokenIsDistinctAndStableForOneKnownBootstrapToken(t *testing.T) {
	egress, err := deriveEgressToken(testBootstrapToken)
	if err != nil {
		t.Fatal(err)
	}
	if egress != "AN43IKRZz4QAd6L6iE-D9mklr0Pm6SEq9jiiB9PAVPo" {
		t.Fatalf("unexpected egress token %q", egress)
	}
	if egress == testBootstrapToken {
		t.Fatal("egress token reused the bootstrap token")
	}
}

func TestEgressPreludeHasNoBootstrapCredentialOrControlFields(t *testing.T) {
	egress, err := deriveEgressToken(testBootstrapToken)
	if err != nil {
		t.Fatal(err)
	}
	var wire bytes.Buffer
	if err := writeGuestEgressPrelude(&wire, egress); err != nil {
		t.Fatal(err)
	}
	expected := append([]byte{'N', 'E', 'X', 'G', 1}, []byte(egress)...)
	if !bytes.Equal(wire.Bytes(), expected) || wire.Len() != guestEgressPreludeN {
		t.Fatalf("unexpected egress prelude %q", wire.Bytes())
	}
	if bytes.Contains(wire.Bytes(), []byte(testBootstrapToken)) {
		t.Fatal("egress prelude leaked the bootstrap token")
	}
}

func TestGuestEgressProxyForwardsOnlyThroughAnAuthenticatedTunnel(t *testing.T) {
	egress, err := deriveEgressToken(testBootstrapToken)
	if err != nil {
		t.Fatal(err)
	}
	upstream, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	received := make(chan []byte, 1)
	request := []byte("CONNECT app.example:443 HTTP/1.1\r\n\r\n")
	response := []byte("HTTP/1.1 200 Connection Established\r\n\r\n")
	go func() {
		connection, acceptErr := upstream.Accept()
		if acceptErr != nil {
			return
		}
		defer connection.Close()
		prelude := make([]byte, guestEgressPreludeN)
		if _, readErr := io.ReadFull(connection, prelude); readErr != nil {
			return
		}
		actualRequest := make([]byte, len(request))
		if _, readErr := io.ReadFull(connection, actualRequest); readErr != nil {
			return
		}
		received <- append(prelude, actualRequest...)
		_, _ = connection.Write(response)
	}()

	proxy, err := startGuestEgressProxy("127.0.0.1:0", egress, func() (net.Conn, error) {
		return net.Dial("tcp4", upstream.Addr().String())
	})
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	client, err := net.Dial("tcp4", proxy.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Write(request); err != nil {
		client.Close()
		t.Fatal(err)
	}
	actualResponse := make([]byte, len(response))
	if _, err := io.ReadFull(client, actualResponse); err != nil {
		client.Close()
		t.Fatal(err)
	}
	if !bytes.Equal(actualResponse, response) {
		client.Close()
		t.Fatalf("unexpected proxy response %q", actualResponse)
	}
	_ = client.Close()

	select {
	case actual := <-received:
		expectedPrelude, preludeErr := preludeForTest(egress)
		if preludeErr != nil {
			t.Fatal(preludeErr)
		}
		if !bytes.Equal(actual, append(expectedPrelude, request...)) {
			t.Fatalf("proxy did not forward the authenticated tunnel stream: %q", actual)
		}
	case <-time.After(time.Second):
		t.Fatal("proxy did not reach the authenticated tunnel")
	}
}

func preludeForTest(sessionToken string) ([]byte, error) {
	var prelude bytes.Buffer
	if err := writeGuestEgressPrelude(&prelude, sessionToken); err != nil {
		return nil, err
	}
	return prelude.Bytes(), nil
}
