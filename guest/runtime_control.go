package main

import (
	"bytes"
	"encoding/json"
	"io"
)

const guestRuntimeControlVersion = 1

type runtimeControlRequest struct {
	Action            string   `json:"action,omitempty"`
	Agent             string   `json:"agent,omitempty"`
	Args              []string `json:"args,omitempty"`
	Cursor            int      `json:"cursor,omitempty"`
	CWD               string   `json:"cwd,omitempty"`
	DeltaY            int      `json:"deltaY,omitempty"`
	IncludeScreenshot bool     `json:"includeScreenshot,omitempty"`
	Key               string   `json:"key,omitempty"`
	MaxResultBytes    int      `json:"maxResultBytes,omitempty"`
	NodeID            *int     `json:"nodeId,omitempty"`
	Offset            int64    `json:"offset,omitempty"`
	Operation         string   `json:"operation"`
	Path              string   `json:"path,omitempty"`
	Program           string   `json:"program,omitempty"`
	Prompt            string   `json:"prompt,omitempty"`
	RuntimeSeconds    int      `json:"runtimeSeconds,omitempty"`
	Text              string   `json:"text,omitempty"`
	URL               string   `json:"url,omitempty"`
	Version           int      `json:"version"`
}

type runtimeInspection struct {
	Browser bool `json:"browser"`
	Claude  bool `json:"claude"`
	Codex   bool `json:"codex"`
	Tmux    bool `json:"tmux"`
}

type runtimeController struct {
	browser  *browserRuntime
	command  *commandRuntime
	coding   *codingRuntime
	drafts   draftSource
	manifest *runtimeManifest
}

// A session can have a draft to report without carrying a runtime bundle — a
// workspace-only guest still edits files — so the controller exists whenever
// either does, and each capability stays independently absent.
func newRuntimeController(manifest *runtimeManifest, drafts draftSource) *runtimeController {
	if manifest == nil && drafts == nil {
		return nil
	}
	controller := &runtimeController{drafts: drafts, manifest: manifest}
	if manifest != nil {
		controller.browser = newBrowserRuntime(manifest)
		controller.command = newCommandRuntime(manifest)
		controller.coding = newCodingRuntime(manifest)
	}
	return controller
}

func (controller *runtimeController) close() {
	if controller != nil && controller.browser != nil {
		controller.browser.close()
	}
	if controller != nil && controller.coding != nil {
		controller.coding.shutdown()
	}
}

func decodeRuntimeControlRequest(payload []byte) (runtimeControlRequest, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var request runtimeControlRequest
	if err := decoder.Decode(&request); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return runtimeControlRequest{}, errInvalidFrame
	}
	if request.Version != guestRuntimeControlVersion {
		return runtimeControlRequest{}, errInvalidFrame
	}
	// The draft fields belong to the draft operations and to nothing else, so
	// every other operation is checked once here rather than restating the
	// three names in each case below.
	if request.Operation != "workspace.draft_scan" && request.Operation != "workspace.draft_read" {
		if request.Cursor != 0 || request.Offset != 0 || request.Path != "" {
			return runtimeControlRequest{}, errInvalidFrame
		}
	}
	switch request.Operation {
	case "workspace.draft_scan":
		if request.URL != "" || request.Agent != "" || request.Prompt != "" || request.Action != "" || request.Program != "" || request.NodeID != nil || request.Key != "" || request.Text != "" || request.DeltaY != 0 || request.CWD != "" || request.RuntimeSeconds != 0 || request.MaxResultBytes != 0 || len(request.Args) != 0 || request.IncludeScreenshot || request.Path != "" || request.Offset != 0 || request.Cursor < 0 {
			return runtimeControlRequest{}, errInvalidFrame
		}
	case "workspace.draft_read":
		if request.URL != "" || request.Agent != "" || request.Prompt != "" || request.Action != "" || request.Program != "" || request.NodeID != nil || request.Key != "" || request.Text != "" || request.DeltaY != 0 || request.CWD != "" || request.RuntimeSeconds != 0 || len(request.Args) != 0 || request.IncludeScreenshot || request.Cursor != 0 || request.Path == "" || len(request.Path) > draftPathMaxBytes || request.Offset < 0 || request.MaxResultBytes <= 0 || request.MaxResultBytes > draftReadMaxBytes {
			return runtimeControlRequest{}, errInvalidFrame
		}
	case "runtime.inspect", "coding.observe", "coding.close":
		if request.URL != "" || request.Agent != "" || request.Prompt != "" || request.Action != "" || request.Program != "" || request.NodeID != nil || request.Key != "" || request.Text != "" || request.DeltaY != 0 || request.CWD != "" || request.RuntimeSeconds != 0 || request.MaxResultBytes != 0 || len(request.Args) != 0 {
			return runtimeControlRequest{}, errInvalidFrame
		}
		if request.IncludeScreenshot {
			return runtimeControlRequest{}, errInvalidFrame
		}
	case "browser.observe":
		if request.URL != "" || request.Agent != "" || request.Prompt != "" || request.Action != "" || request.Program != "" || request.NodeID != nil || request.Key != "" || request.Text != "" || request.DeltaY != 0 || request.CWD != "" || request.RuntimeSeconds != 0 || request.MaxResultBytes != 0 || len(request.Args) != 0 {
			return runtimeControlRequest{}, errInvalidFrame
		}
	case "browser.open":
		if request.Agent != "" || request.Prompt != "" || request.Action != "" || request.Program != "" || request.NodeID != nil || request.Key != "" || request.Text != "" || request.DeltaY != 0 || request.CWD != "" || request.RuntimeSeconds != 0 || request.MaxResultBytes != 0 || len(request.Args) != 0 || !validBrowserURL(request.URL) {
			return runtimeControlRequest{}, errInvalidFrame
		}
	case "browser.act":
		if request.Agent != "" || request.Prompt != "" || request.Program != "" || request.CWD != "" || request.RuntimeSeconds != 0 || request.MaxResultBytes != 0 || len(request.Args) != 0 || request.IncludeScreenshot || !validBrowserActionRequest(request) {
			return runtimeControlRequest{}, errInvalidFrame
		}
	case "command.run":
		if request.Agent != "" || request.Prompt != "" || request.Action != "" || request.NodeID != nil || request.Key != "" || request.Text != "" || request.DeltaY != 0 || request.URL != "" || request.IncludeScreenshot || request.Args == nil || !validCommandRequest(commandRequestFromRuntime(request)) {
			return runtimeControlRequest{}, errInvalidFrame
		}
	case "coding.launch":
		if request.URL != "" || request.Action != "" || request.Program != "" || request.NodeID != nil || request.Key != "" || request.Text != "" || request.DeltaY != 0 || request.CWD != "" || request.RuntimeSeconds != 0 || request.MaxResultBytes != 0 || len(request.Args) != 0 || !validCodingAgent(codingAgent(request.Agent)) || !validCodingPrompt(request.Prompt) {
			return runtimeControlRequest{}, errInvalidFrame
		}
	default:
		return runtimeControlRequest{}, errInvalidFrame
	}
	return request, nil
}

func browserActionFromRequest(request runtimeControlRequest) browserAction {
	action := browserAction{
		Action: request.Action, DeltaY: request.DeltaY, Key: request.Key,
		Text: request.Text, URL: request.URL,
	}
	if request.NodeID != nil {
		action.HasNodeID = true
		action.NodeID = *request.NodeID
	}
	return action
}

func validBrowserActionRequest(request runtimeControlRequest) bool {
	action := browserActionFromRequest(request)
	if !validBrowserAction(action) {
		return false
	}
	switch action.Action {
	case "navigate":
		return !action.HasNodeID && action.Key == "" && action.Text == "" && action.DeltaY == 0
	case "click":
		return action.HasNodeID && action.Key == "" && action.Text == "" && action.URL == "" && action.DeltaY == 0
	case "type":
		return action.HasNodeID && action.Key == "" && action.URL == "" && action.DeltaY == 0
	case "press":
		return !action.HasNodeID && action.Text == "" && action.URL == "" && action.DeltaY == 0
	case "scroll":
		return action.Key == "" && action.Text == "" && action.URL == ""
	default:
		return false
	}
}

func commandRequestFromRuntime(request runtimeControlRequest) commandRequest {
	return commandRequest{
		Args: request.Args, CWD: request.CWD, MaxResultBytes: request.MaxResultBytes,
		Program: request.Program, RuntimeSeconds: request.RuntimeSeconds,
	}
}

func runtimeControlUnavailable() []byte {
	return []byte(`{"code":"EXECUTOR_GUEST_CAPABILITY_UNAVAILABLE"}`)
}

func handleRuntimeControlRequest(payload []byte, controller *runtimeController) []byte {
	request, err := decodeRuntimeControlRequest(payload)
	if err != nil || controller == nil {
		return runtimeControlUnavailable()
	}
	if request.Operation == "workspace.draft_scan" {
		if controller.drafts == nil {
			return runtimeControlUnavailable()
		}
		scan, err := controller.drafts.scan(request.Cursor)
		if err != nil {
			return runtimeControlUnavailable()
		}
		result, err := json.Marshal(scan)
		if err != nil {
			return runtimeControlUnavailable()
		}
		return result
	}
	if request.Operation == "workspace.draft_read" {
		if controller.drafts == nil {
			return runtimeControlUnavailable()
		}
		chunk, err := controller.drafts.read(request.Path, request.Offset, request.MaxResultBytes)
		if err != nil {
			return runtimeControlUnavailable()
		}
		result, err := json.Marshal(chunk)
		if err != nil {
			return runtimeControlUnavailable()
		}
		return result
	}
	if request.Operation == "browser.open" {
		if controller.browser == nil || controller.browser.open(request.URL) != nil {
			return runtimeControlUnavailable()
		}
		return []byte(`{"status":"started","version":1}`)
	}
	if request.Operation == "browser.observe" {
		if controller.browser == nil {
			return runtimeControlUnavailable()
		}
		observation, err := controller.browser.observation(request.IncludeScreenshot)
		if err != nil {
			return runtimeControlUnavailable()
		}
		result, err := json.Marshal(struct {
			Observation browserObservation `json:"observation"`
			Version     int                `json:"version"`
		}{Observation: observation, Version: guestRuntimeControlVersion})
		if err != nil {
			return runtimeControlUnavailable()
		}
		return result
	}
	if request.Operation == "browser.act" {
		if controller.browser == nil {
			return runtimeControlUnavailable()
		}
		result, err := controller.browser.action(browserActionFromRequest(request))
		if err != nil {
			return runtimeControlUnavailable()
		}
		encoded, err := json.Marshal(struct {
			Action  browserActionResult `json:"action"`
			Version int                 `json:"version"`
		}{Action: result, Version: guestRuntimeControlVersion})
		if err != nil {
			return runtimeControlUnavailable()
		}
		return encoded
	}
	if request.Operation == "command.run" {
		if controller.command == nil {
			return runtimeControlUnavailable()
		}
		result, err := controller.command.execute(commandRequestFromRuntime(request))
		if err != nil {
			return runtimeControlUnavailable()
		}
		encoded, err := json.Marshal(struct {
			Result  commandResult `json:"result"`
			Version int           `json:"version"`
		}{Result: result, Version: guestRuntimeControlVersion})
		if err != nil {
			return runtimeControlUnavailable()
		}
		return encoded
	}
	if request.Operation == "coding.launch" {
		if controller.coding == nil || controller.coding.launch(codingAgent(request.Agent), request.Prompt) != nil {
			return runtimeControlUnavailable()
		}
		result, err := json.Marshal(struct {
			Agent   codingAgent `json:"agent"`
			Status  string      `json:"status"`
			Version int         `json:"version"`
		}{Agent: codingAgent(request.Agent), Status: "started", Version: guestRuntimeControlVersion})
		if err != nil {
			return runtimeControlUnavailable()
		}
		return result
	}
	if request.Operation == "coding.observe" {
		if controller.coding == nil {
			return runtimeControlUnavailable()
		}
		observation, err := controller.coding.observation()
		if err != nil {
			return runtimeControlUnavailable()
		}
		result, err := json.Marshal(struct {
			Observation codingObservation `json:"observation"`
			Version     int               `json:"version"`
		}{Observation: observation, Version: guestRuntimeControlVersion})
		if err != nil {
			return runtimeControlUnavailable()
		}
		return result
	}
	if request.Operation == "coding.close" {
		if controller.coding == nil || controller.coding.close() != nil {
			return runtimeControlUnavailable()
		}
		return []byte(`{"status":"closed","version":1}`)
	}
	result, err := json.Marshal(struct {
		Inspection runtimeInspection `json:"inspection"`
		Version    int               `json:"version"`
	}{
		Inspection: runtimeInspection{
			Browser: controller.browser != nil,
			Claude:  controller.coding != nil && controller.manifest.Entrypoints["claude"] != "",
			Codex:   controller.command != nil,
			Tmux:    controller.coding != nil,
		},
		Version: guestRuntimeControlVersion,
	})
	if err != nil {
		return runtimeControlUnavailable()
	}
	return result
}
