package main

import (
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
)

const (
	browserProfileDirectory = "/work/.nessie-executor/browser"
	browserProxyAddress     = "http://127.0.0.1:8137"
	browserDevToolsAddress  = "127.0.0.1:9222"
	browserDevToolsURL      = "http://127.0.0.1:9222/json/list"
	maxBrowserURLBytes      = 4_096
	maxBrowserTargets       = 32
)

type browserProcess interface {
	Kill() error
	Wait() error
}

type browserLauncher func(path string, args, environment []string) (browserProcess, error)
type browserObserver func(includeScreenshot bool) (browserObservation, error)
type browserActor func(browserAction) (browserActionResult, error)

type browserObservation struct {
	SnapshotVersion   int                `json:"snapshotVersion,omitempty"`
	AccessibilityTree []browserAXNode    `json:"accessibilityTree"`
	Screenshot        *browserScreenshot `json:"screenshot,omitempty"`
	Targets           []browserTarget    `json:"targets"`
}

type browserTarget struct {
	Title string `json:"title"`
	Type  string `json:"type"`
	URL   string `json:"url"`
}

type browserAXNode struct {
	SnapshotExcluded bool    `json:"snapshotExcluded,omitempty"`
	SnapshotName     *string `json:"snapshotName,omitempty"`
	Name             string  `json:"name"`
	NodeID           int     `json:"nodeId"`
	Role             string  `json:"role"`
	Value            string  `json:"value,omitempty"`
}

type browserScreenshot struct {
	DataBase64 string `json:"dataBase64"`
	MIME       string `json:"mime"`
}

type browserRuntime struct {
	executable      string
	launch          browserLauncher
	observe         browserObserver
	act             browserActor
	profile         string
	profileRoot     string
	mu              sync.Mutex
	process         browserProcess
	generation      uint64
	observedNodeIDs map[int]struct{}
}

func newBrowserRuntime(manifest *runtimeManifest) *browserRuntime {
	if manifest == nil || manifest.Entrypoints["browser"] == "" {
		return nil
	}
	return &browserRuntime{
		executable:      filepath.Join("/runtime", filepath.FromSlash(manifest.Entrypoints["browser"])),
		launch:          launchBrowserProcess,
		observe:         observeBrowser,
		act:             actBrowser,
		profile:         browserProfileDirectory,
		profileRoot:     "/work",
		observedNodeIDs: map[int]struct{}{},
	}
}

func validBrowserURL(raw string) bool {
	if raw == "" || len(raw) > maxBrowserURLBytes {
		return false
	}
	parsed, err := url.ParseRequestURI(raw)
	return err == nil && parsed.Scheme == "https" && parsed.Hostname() != "" && parsed.Port() == "" && parsed.User == nil
}

func (browser *browserRuntime) open(rawURL string) error {
	if !validBrowserURL(rawURL) {
		return errInvalidFrame
	}
	browser.mu.Lock()
	defer browser.mu.Unlock()
	if browser.process != nil {
		return errInvalidFrame
	}
	if err := secureBrowserProfile(browser.profileRoot, browser.profile); err != nil {
		return err
	}
	process, err := browser.launch(browser.executable, fixedBrowserArguments(rawURL, browser.profile), browserEnvironment(browser.profile))
	if err != nil {
		return err
	}
	browser.process = process
	browser.generation++
	generation := browser.generation
	go func() {
		_ = process.Wait()
		browser.mu.Lock()
		if browser.generation == generation {
			browser.process = nil
		}
		browser.mu.Unlock()
	}()
	return nil
}

func secureBrowserProfile(root, profile string) error {
	relative, err := filepath.Rel(root, profile)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errInvalidFrame
	}
	current := root
	parts := strings.Split(relative, string(filepath.Separator))
	for index, part := range parts {
		if part == "" || part == "." || part == ".." {
			return errInvalidFrame
		}
		current = filepath.Join(current, part)
		err := os.Mkdir(current, 0o700)
		if index == len(parts)-1 && os.IsExist(err) {
			// `/work` is a COW copy of the paired workspace. A pre-existing
			// browser leaf could contain cookies, extensions, or other ambient
			// authority, so only this fresh guest may create it.
			return errInvalidFrame
		}
		if err != nil && !os.IsExist(err) {
			return err
		}
		info, err := os.Lstat(current)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
			return errInvalidFrame
		}
		stat, isCurrentOwner := info.Sys().(*syscall.Stat_t)
		if !isCurrentOwner || stat.Uid != uint32(os.Geteuid()) {
			return errInvalidFrame
		}
	}
	return nil
}

func (browser *browserRuntime) close() {
	browser.mu.Lock()
	process := browser.process
	browser.process = nil
	browser.generation++
	browser.mu.Unlock()
	if process != nil {
		_ = process.Kill()
	}
}

func (browser *browserRuntime) observation(includeScreenshot bool) (browserObservation, error) {
	browser.mu.Lock()
	active := browser.process != nil
	observer := browser.observe
	browser.mu.Unlock()
	if !active || observer == nil {
		return browserObservation{}, errInvalidFrame
	}
	observation, err := observer(includeScreenshot)
	if err != nil {
		return browserObservation{}, err
	}
	nodes := make(map[int]struct{}, len(observation.AccessibilityTree))
	for _, node := range observation.AccessibilityTree {
		nodes[node.NodeID] = struct{}{}
	}
	browser.mu.Lock()
	if browser.process == nil {
		browser.mu.Unlock()
		return browserObservation{}, errInvalidFrame
	}
	browser.observedNodeIDs = nodes
	browser.mu.Unlock()
	return observation, nil
}

func (browser *browserRuntime) action(action browserAction) (browserActionResult, error) {
	browser.mu.Lock()
	active := browser.process != nil
	actor := browser.act
	_, observed := browser.observedNodeIDs[action.NodeID]
	browser.mu.Unlock()
	if !active || actor == nil || !validBrowserAction(action) {
		return browserActionResult{}, errInvalidFrame
	}
	if browserActionRequiresNode(action) && !observed {
		return browserActionResult{}, errInvalidFrame
	}
	// Every mutating action invalidates the prior snapshot. A caller must
	// observe again before it can target another element, so a backend node id
	// cannot be replayed across navigation or DOM churn.
	defer func() {
		browser.mu.Lock()
		browser.observedNodeIDs = map[int]struct{}{}
		browser.mu.Unlock()
	}()
	return actor(action)
}

func fixedBrowserArguments(rawURL, profile string) []string {
	return []string{
		"--disable-background-networking",
		"--disable-default-apps",
		"--disable-quic",
		"--no-default-browser-check",
		"--no-first-run",
		"--proxy-bypass-list=<-loopback>",
		"--proxy-server=" + browserProxyAddress,
		"--remote-debugging-address=127.0.0.1",
		"--remote-debugging-port=9222",
		"--user-data-dir=" + profile,
		rawURL,
	}
}

func browserEnvironment(profile string) []string {
	return []string{
		"HOME=" + profile,
		"TMPDIR=" + profile,
	}
}

type execBrowserProcess struct {
	command *exec.Cmd
}

func (process *execBrowserProcess) Kill() error {
	return process.command.Process.Kill()
}

func (process *execBrowserProcess) Wait() error {
	return process.command.Wait()
}

func launchBrowserProcess(path string, args, environment []string) (browserProcess, error) {
	command := exec.Command(path, args...)
	command.Dir = "/work"
	command.Env = environment
	command.Stderr = io.Discard
	command.Stdout = io.Discard
	if err := command.Start(); err != nil {
		return nil, err
	}
	return &execBrowserProcess{command: command}, nil
}

func safeObservedBrowserURL(raw string) (string, bool) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.Port() != "" || parsed.User != nil {
		return "", false
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	value := parsed.String()
	return value, len(value) <= maxBrowserURLBytes
}
