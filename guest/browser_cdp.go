package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	maxBrowserAXNodes         = 200
	maxBrowserAXNodeTextBytes = 256
	maxBrowserCDPMessageBytes = 48 * 1_024
	maxBrowserObserveBytes    = 24 * 1_024
	maxBrowserScreenshotBytes = 8 * 1_024
	maxBrowserNodeID          = 2_147_483_647
)

type browserAction struct {
	Action    string
	DeltaY    int
	HasNodeID bool
	Key       string
	NodeID    int
	Text      string
	URL       string
}

type browserActionResult struct {
	SettledURL string `json:"settledUrl,omitempty"`
	Status     string `json:"status"`
}

type browserDevToolsTarget struct {
	Title                string `json:"title"`
	Type                 string `json:"type"`
	URL                  string `json:"url"`
	WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
}

func validBrowserAction(action browserAction) bool {
	switch action.Action {
	case "navigate":
		return validBrowserURL(action.URL)
	case "click":
		return action.NodeID >= 0 && action.NodeID <= maxBrowserNodeID
	case "type":
		return action.NodeID >= 0 && action.NodeID <= maxBrowserNodeID && len([]byte(action.Text)) <= 4_096
	case "press":
		_, ok := browserKeyDetails(action.Key)
		return ok
	case "scroll":
		return action.DeltaY >= -10_000 && action.DeltaY <= 10_000 && action.DeltaY != 0
	default:
		return false
	}
}

func browserActionRequiresNode(action browserAction) bool {
	return action.Action == "click" || action.Action == "type" || action.HasNodeID
}

func observeBrowser(includeScreenshot bool) (browserObservation, error) {
	targets, page, err := listBrowserTargets()
	if err != nil {
		return browserObservation{}, err
	}
	cdp, err := dialBrowserCDP(page.WebSocketDebuggerURL)
	if err != nil {
		return browserObservation{}, err
	}
	defer cdp.Close()
	nodes, err := cdp.accessibilityTree()
	if err != nil {
		return browserObservation{}, err
	}
	var screenshot *browserScreenshot
	if includeScreenshot {
		// The image is an optional enhancement. Preserve the a11y-first
		// observation when a page cannot produce a small enough WebP.
		screenshot, _ = cdp.screenshot()
	}
	return boundedBrowserObservation(targets, nodes, screenshot)
}

// Keep observations useful rather than failing them wholesale when a page has
// hundreds of long accessibility labels. The control payload remains strictly
// below the inherited 64 KiB frame ceiling; its 24 KiB sub-cap leaves room for
// the authenticated envelope. Accessibility is appended before target metadata
// and the optional image, making it the first-class model signal.
func boundedBrowserObservation(
	targets []browserTarget,
	nodes []browserAXNode,
	screenshot *browserScreenshot,
) (browserObservation, error) {
	observation := browserObservation{
		SnapshotVersion:   1,
		AccessibilityTree: make([]browserAXNode, 0, min(len(nodes), maxBrowserAXNodes)),
		Targets:           make([]browserTarget, 0, min(len(targets), maxBrowserTargets)),
	}
	withinLimit := func(candidate browserObservation) bool {
		encoded, err := json.Marshal(candidate)
		return err == nil && len(encoded) <= maxBrowserObserveBytes
	}
	for _, node := range nodes {
		if len(observation.AccessibilityTree) == maxBrowserAXNodes {
			break
		}
		candidate := observation
		candidate.AccessibilityTree = append(append([]browserAXNode{}, observation.AccessibilityTree...), node)
		if !withinLimit(candidate) {
			break
		}
		observation = candidate
	}
	for _, target := range targets {
		if len(observation.Targets) == maxBrowserTargets {
			break
		}
		candidate := observation
		candidate.Targets = append(append([]browserTarget{}, observation.Targets...), target)
		if !withinLimit(candidate) {
			break
		}
		observation = candidate
	}
	if screenshot != nil {
		candidate := observation
		candidate.Screenshot = screenshot
		if withinLimit(candidate) {
			observation = candidate
		}
	}
	if !withinLimit(observation) {
		return browserObservation{}, errInvalidFrame
	}
	return observation, nil
}

func actBrowser(action browserAction) (browserActionResult, error) {
	_, page, err := listBrowserTargets()
	if err != nil {
		return browserActionResult{}, err
	}
	cdp, err := dialBrowserCDP(page.WebSocketDebuggerURL)
	if err != nil {
		return browserActionResult{}, err
	}
	defer cdp.Close()
	switch action.Action {
	case "navigate":
		if _, err := cdp.call("Page.navigate", map[string]any{"url": action.URL}); err != nil {
			return browserActionResult{}, err
		}
		settledURL, ok := safeObservedBrowserURL(action.URL)
		if !ok {
			return browserActionResult{}, errInvalidFrame
		}
		return browserActionResult{SettledURL: settledURL, Status: "acted"}, nil
	case "click":
		if err := cdp.scrollIntoView(action.NodeID); err != nil {
			return browserActionResult{}, err
		}
		x, y, err := cdp.nodeCenter(action.NodeID)
		if err != nil {
			return browserActionResult{}, err
		}
		if _, err := cdp.call("Input.dispatchMouseEvent", map[string]any{"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1}); err != nil {
			return browserActionResult{}, err
		}
		_, err = cdp.call("Input.dispatchMouseEvent", map[string]any{"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})
	case "type":
		if _, err := cdp.call("DOM.focus", map[string]any{"backendNodeId": action.NodeID}); err != nil {
			return browserActionResult{}, err
		}
		_, err = cdp.call("Input.insertText", map[string]any{"text": action.Text})
	case "press":
		key, ok := browserKeyDetails(action.Key)
		if !ok {
			return browserActionResult{}, errInvalidFrame
		}
		if _, err := cdp.call("Input.dispatchKeyEvent", map[string]any{"type": "rawKeyDown", "key": key.key, "code": key.code, "windowsVirtualKeyCode": key.windowsVirtualKeyCode}); err != nil {
			return browserActionResult{}, err
		}
		_, err = cdp.call("Input.dispatchKeyEvent", map[string]any{"type": "keyUp", "key": key.key, "code": key.code, "windowsVirtualKeyCode": key.windowsVirtualKeyCode})
	case "scroll":
		if action.HasNodeID {
			if err := cdp.scrollIntoView(action.NodeID); err != nil {
				return browserActionResult{}, err
			}
		}
		x, y, err := cdp.viewportCenter()
		if err != nil {
			return browserActionResult{}, err
		}
		_, err = cdp.call("Input.dispatchMouseEvent", map[string]any{"type": "mouseWheel", "x": x, "y": y, "deltaX": 0, "deltaY": action.DeltaY})
	}
	if err != nil {
		return browserActionResult{}, err
	}
	return browserActionResult{Status: "acted"}, nil
}

func listBrowserTargets() ([]browserTarget, browserDevToolsTarget, error) {
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Timeout:       2 * time.Second,
		Transport:     &http.Transport{DialContext: dialBrowserDevTools, Proxy: nil},
	}
	response, err := client.Get(browserDevToolsURL)
	if err != nil {
		return nil, browserDevToolsTarget{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, browserDevToolsTarget{}, errInvalidFrame
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxBrowserCDPMessageBytes+1))
	if err != nil || len(body) > maxBrowserCDPMessageBytes {
		return nil, browserDevToolsTarget{}, errInvalidFrame
	}
	var raw []browserDevToolsTarget
	if json.Unmarshal(body, &raw) != nil || len(raw) > maxBrowserTargets {
		return nil, browserDevToolsTarget{}, errInvalidFrame
	}
	targets := make([]browserTarget, 0, len(raw))
	var page browserDevToolsTarget
	for _, target := range raw {
		if target.Type != "page" || len(target.Title) > 512 {
			return nil, browserDevToolsTarget{}, errInvalidFrame
		}
		safeURL, ok := safeObservedBrowserURL(target.URL)
		if !ok {
			return nil, browserDevToolsTarget{}, errInvalidFrame
		}
		if page.WebSocketDebuggerURL == "" && validBrowserCDPURL(target.WebSocketDebuggerURL) {
			page = target
		}
		targets = append(targets, browserTarget{Title: target.Title, Type: target.Type, URL: safeURL})
	}
	if page.WebSocketDebuggerURL == "" {
		return nil, browserDevToolsTarget{}, errInvalidFrame
	}
	return targets, page, nil
}

func dialBrowserDevTools(ctx context.Context, network, address string) (net.Conn, error) {
	if network != "tcp" || address != browserDevToolsAddress {
		return nil, errors.New("unexpected browser DevTools destination")
	}
	return (&net.Dialer{}).DialContext(ctx, network, address)
}

func validBrowserCDPURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "ws" && parsed.Host == browserDevToolsAddress && parsed.User == nil
}

type browserCDP struct {
	connection net.Conn
	reader     *bufio.Reader
	nextID     int
}

func dialBrowserCDP(rawURL string) (*browserCDP, error) {
	if !validBrowserCDPURL(rawURL) {
		return nil, errInvalidFrame
	}
	parsed, _ := url.Parse(rawURL)
	connection, err := net.DialTimeout("tcp", browserDevToolsAddress, 2*time.Second)
	if err != nil {
		return nil, err
	}
	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		_ = connection.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)
	request := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n", parsed.RequestURI(), browserDevToolsAddress, key)
	if _, err := io.WriteString(connection, request); err != nil {
		_ = connection.Close()
		return nil, err
	}
	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil || response.StatusCode != http.StatusSwitchingProtocols || response.Header.Get("Sec-WebSocket-Accept") != browserCDPAccept(key) {
		_ = connection.Close()
		return nil, errInvalidFrame
	}
	return &browserCDP{connection: connection, reader: reader, nextID: 1}, nil
}

func browserCDPAccept(key string) string {
	hash := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(hash[:])
}

func (cdp *browserCDP) Close() error { return cdp.connection.Close() }

func (cdp *browserCDP) call(method string, params map[string]any) (json.RawMessage, error) {
	id := cdp.nextID
	cdp.nextID++
	payload, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil || len(payload) > maxBrowserCDPMessageBytes {
		return nil, errInvalidFrame
	}
	if err := cdp.writeMessage(0x1, payload); err != nil {
		return nil, err
	}
	for {
		message, err := cdp.readMessage()
		if err != nil {
			return nil, err
		}
		var response struct {
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
		}
		if json.Unmarshal(message, &response) != nil || response.ID != id {
			continue
		}
		if response.Error != nil || response.Result == nil {
			return nil, errInvalidFrame
		}
		return response.Result, nil
	}
}

func (cdp *browserCDP) accessibilityTree() ([]browserAXNode, error) {
	result, err := cdp.call("Accessibility.getFullAXTree", map[string]any{})
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Nodes []snapshotAXNode `json:"nodes"`
	}
	if json.Unmarshal(result, &parsed) != nil {
		return nil, errInvalidFrame
	}
	metadata := accessibilitySnapshotMetadata(parsed.Nodes)
	nodes := make([]browserAXNode, 0, maxBrowserAXNodes)
	for _, node := range parsed.Nodes {
		role := boundedBrowserText(node.Role.Value, maxBrowserAXNodeTextBytes)
		name := boundedBrowserText(node.Name.Value, maxBrowserAXNodeTextBytes)
		value := boundedBrowserText(node.Value.Value, maxBrowserAXNodeTextBytes)
		if node.BackendDOMNodeID <= 0 || role == "" || (name == "" && value == "") {
			continue
		}
		projected := metadata[node.NodeID]
		if projected.name != nil {
			text := boundedBrowserText(*projected.name, maxBrowserAXNodeTextBytes)
			projected.name = &text
		}
		nodes = append(nodes, browserAXNode{NodeID: node.BackendDOMNodeID, Role: role, Name: name, Value: value,
			SnapshotExcluded: projected.excluded, SnapshotName: projected.name})
		if len(nodes) == maxBrowserAXNodes {
			break
		}
	}
	return nodes, nil
}

func (cdp *browserCDP) screenshot() (*browserScreenshot, error) {
	x, y, err := cdp.viewportCenter()
	if err != nil {
		return nil, err
	}
	width := math.Max(1, x*2)
	height := math.Max(1, y*2)
	scale := math.Min(1, 1_024/math.Max(width, height))
	result, err := cdp.call("Page.captureScreenshot", map[string]any{
		"format": "webp", "quality": 40,
		"clip": map[string]float64{"x": 0, "y": 0, "width": width, "height": height, "scale": scale},
	})
	if err != nil {
		return nil, err
	}
	var screenshot struct {
		Data string `json:"data"`
	}
	if json.Unmarshal(result, &screenshot) != nil || screenshot.Data == "" {
		return nil, errInvalidFrame
	}
	decoded, err := base64.StdEncoding.DecodeString(screenshot.Data)
	if err != nil || len(decoded) > maxBrowserScreenshotBytes {
		return nil, errInvalidFrame
	}
	return &browserScreenshot{DataBase64: screenshot.Data, MIME: "image/webp"}, nil
}

func (cdp *browserCDP) nodeCenter(nodeID int) (float64, float64, error) {
	result, err := cdp.call("DOM.getBoxModel", map[string]any{"backendNodeId": nodeID})
	if err != nil {
		return 0, 0, err
	}
	var parsed struct {
		Model struct {
			Content []float64 `json:"content"`
		} `json:"model"`
	}
	if json.Unmarshal(result, &parsed) != nil || len(parsed.Model.Content) != 8 {
		return 0, 0, errInvalidFrame
	}
	return (parsed.Model.Content[0] + parsed.Model.Content[2] + parsed.Model.Content[4] + parsed.Model.Content[6]) / 4,
		(parsed.Model.Content[1] + parsed.Model.Content[3] + parsed.Model.Content[5] + parsed.Model.Content[7]) / 4, nil
}

func (cdp *browserCDP) viewportCenter() (float64, float64, error) {
	result, err := cdp.call("Page.getLayoutMetrics", map[string]any{})
	if err != nil {
		return 0, 0, err
	}
	var parsed struct {
		VisualViewport struct {
			ClientHeight float64 `json:"clientHeight"`
			ClientWidth  float64 `json:"clientWidth"`
		} `json:"visualViewport"`
	}
	if json.Unmarshal(result, &parsed) != nil || parsed.VisualViewport.ClientHeight <= 0 || parsed.VisualViewport.ClientWidth <= 0 {
		return 0, 0, errInvalidFrame
	}
	return parsed.VisualViewport.ClientWidth / 2, parsed.VisualViewport.ClientHeight / 2, nil
}

func (cdp *browserCDP) scrollIntoView(nodeID int) error {
	_, err := cdp.call("DOM.scrollIntoViewIfNeeded", map[string]any{"backendNodeId": nodeID})
	return err
}

func (cdp *browserCDP) writeMessage(opcode byte, payload []byte) error {
	if len(payload) > maxBrowserCDPMessageBytes {
		return errInvalidFrame
	}
	header := []byte{0x80 | opcode, 0x80}
	switch {
	case len(payload) < 126:
		header[1] |= byte(len(payload))
	case len(payload) <= math.MaxUint16:
		header[1] |= 126
		header = append(header, 0, 0)
		binary.BigEndian.PutUint16(header[len(header)-2:], uint16(len(payload)))
	default:
		return errInvalidFrame
	}
	mask := make([]byte, 4)
	if _, err := rand.Read(mask); err != nil {
		return err
	}
	header = append(header, mask...)
	masked := append([]byte{}, payload...)
	for index := range masked {
		masked[index] ^= mask[index%len(mask)]
	}
	if _, err := cdp.connection.Write(header); err != nil {
		return err
	}
	_, err := cdp.connection.Write(masked)
	return err
}

func (cdp *browserCDP) readMessage() ([]byte, error) {
	for {
		first, err := cdp.reader.ReadByte()
		if err != nil || first&0x80 == 0 {
			return nil, errInvalidFrame
		}
		second, err := cdp.reader.ReadByte()
		if err != nil || second&0x80 != 0 {
			return nil, errInvalidFrame
		}
		length := int(second & 0x7f)
		if length == 126 {
			var extended uint16
			if binary.Read(cdp.reader, binary.BigEndian, &extended) != nil {
				return nil, errInvalidFrame
			}
			length = int(extended)
		}
		if length < 0 || length > maxBrowserCDPMessageBytes {
			return nil, errInvalidFrame
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(cdp.reader, payload); err != nil {
			return nil, err
		}
		switch first & 0x0f {
		case 0x1:
			return payload, nil
		case 0x9:
			if err := cdp.writeMessage(0xa, payload); err != nil {
				return nil, err
			}
		case 0x8:
			return nil, errInvalidFrame
		default:
			return nil, errInvalidFrame
		}
	}
}

func boundedBrowserText(value string, maximum int) string {
	value = strings.ToValidUTF8(value, "")
	if len(value) <= maximum {
		return value
	}
	value = value[:maximum]
	for !utf8.ValidString(value) {
		_, size := utf8.DecodeLastRuneInString(value)
		value = value[:len(value)-size]
	}
	return value
}

type browserKey struct {
	code                  string
	key                   string
	windowsVirtualKeyCode int
}

func browserKeyDetails(value string) (browserKey, bool) {
	keys := map[string]browserKey{
		"Enter": {"Enter", "Enter", 13}, "Escape": {"Escape", "Escape", 27}, "Tab": {"Tab", "Tab", 9},
		"ArrowUp": {"ArrowUp", "ArrowUp", 38}, "ArrowDown": {"ArrowDown", "ArrowDown", 40},
		"ArrowLeft": {"ArrowLeft", "ArrowLeft", 37}, "ArrowRight": {"ArrowRight", "ArrowRight", 39},
		"Backspace": {"Backspace", "Backspace", 8}, "Delete": {"Delete", "Delete", 46}, "Home": {"Home", "Home", 36},
		"End": {"End", "End", 35}, "PageUp": {"PageUp", "PageUp", 33}, "PageDown": {"PageDown", "PageDown", 34},
		"Space": {"Space", " ", 32},
	}
	key, ok := keys[value]
	return key, ok
}
