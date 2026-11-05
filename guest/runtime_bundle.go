package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	maxRuntimeFiles = 4096
)

type runtimeManifestFile struct {
	Executable bool   `json:"executable"`
	Path       string `json:"path"`
	SHA256     string `json:"sha256"`
}

type runtimeManifest struct {
	Entrypoints map[string]string     `json:"entrypoints"`
	Files       []runtimeManifestFile `json:"files"`
	Version     int                   `json:"version"`
}

func runtimeManifestDigest(commandLine string) (string, bool) {
	var digest string
	for _, argument := range strings.Fields(commandLine) {
		if !strings.HasPrefix(argument, "nessie.runtime_manifest=") {
			continue
		}
		if digest != "" {
			return "", false
		}
		digest = strings.TrimPrefix(argument, "nessie.runtime_manifest=")
	}
	return digest, validRuntimeDigest(digest)
}

func validRuntimeDigest(value string) bool {
	if len(value) != 71 || !strings.HasPrefix(value, "sha256:") {
		return false
	}
	_, err := hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
	return err == nil
}

func safeRuntimePath(value string) bool {
	if value == "" || len(value) > 1024 || strings.Contains(value, "\\") {
		return false
	}
	for _, piece := range strings.Split(value, "/") {
		if piece == "" || piece == "." || piece == ".." {
			return false
		}
	}
	return true
}

func runtimeFileDigest(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func runtimeFiles(root string) ([]string, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	files := []string{}
	for _, entry := range entries {
		path := filepath.Join(root, entry.Name())
		info, err := os.Lstat(path)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return nil, errInvalidFrame
		}
		if info.IsDir() {
			children, err := runtimeFiles(path)
			if err != nil {
				return nil, err
			}
			for _, child := range children {
				files = append(files, filepath.Join(entry.Name(), child))
			}
			continue
		}
		if !info.Mode().IsRegular() {
			return nil, errInvalidFrame
		}
		files = append(files, entry.Name())
	}
	return files, nil
}

func verifyMountedGuestRuntime(expectedDigest string) (runtimeManifest, error) {
	return loadVerifiedGuestRuntime("/runtime", expectedDigest)
}

func verifyGuestRuntime(root, expectedDigest string) error {
	_, err := loadVerifiedGuestRuntime(root, expectedDigest)
	return err
}

func loadVerifiedGuestRuntime(root, expectedDigest string) (runtimeManifest, error) {
	manifestBytes, err := os.ReadFile(filepath.Join(root, "nessie-guest-runtime.json"))
	if err != nil {
		return runtimeManifest{}, errInvalidFrame
	}
	manifestHash := sha256.Sum256(manifestBytes)
	if "sha256:"+hex.EncodeToString(manifestHash[:]) != expectedDigest {
		return runtimeManifest{}, errInvalidFrame
	}
	var manifest runtimeManifest
	if json.Unmarshal(manifestBytes, &manifest) != nil || manifest.Version != 1 || len(manifest.Files) == 0 || len(manifest.Files) > maxRuntimeFiles {
		return runtimeManifest{}, errInvalidFrame
	}
	declared := map[string]runtimeManifestFile{}
	for _, file := range manifest.Files {
		if !safeRuntimePath(file.Path) || len(file.SHA256) != 64 || !strings.EqualFold(file.SHA256, strings.ToLower(file.SHA256)) {
			return runtimeManifest{}, errInvalidFrame
		}
		if _, err := hex.DecodeString(file.SHA256); err != nil {
			return runtimeManifest{}, errInvalidFrame
		}
		if _, exists := declared[file.Path]; exists {
			return runtimeManifest{}, errInvalidFrame
		}
		declared[file.Path] = file
	}
	if len(manifest.Entrypoints) == 0 || (manifest.Entrypoints["browser"] == "" && manifest.Entrypoints["tmux"] == "") {
		return runtimeManifest{}, errInvalidFrame
	}
	for name, entrypoint := range manifest.Entrypoints {
		if name != "browser" && name != "tmux" && name != "codex" && name != "claude" {
			return runtimeManifest{}, errInvalidFrame
		}
		file, exists := declared[entrypoint]
		if !exists || !file.Executable {
			return runtimeManifest{}, errInvalidFrame
		}
	}
	actual, err := runtimeFiles(root)
	if err != nil {
		return runtimeManifest{}, err
	}
	filtered := make([]string, 0, len(actual))
	for _, path := range actual {
		if path != "nessie-guest-runtime.json" {
			filtered = append(filtered, filepath.ToSlash(path))
		}
	}
	if len(filtered) != len(declared) {
		return runtimeManifest{}, errInvalidFrame
	}
	sort.Strings(filtered)
	for _, path := range filtered {
		file, exists := declared[path]
		if !exists {
			return runtimeManifest{}, errInvalidFrame
		}
		info, err := os.Lstat(filepath.Join(root, path))
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
			return runtimeManifest{}, errInvalidFrame
		}
		if file.Executable != (info.Mode().Perm()&0o100 != 0) {
			return runtimeManifest{}, errInvalidFrame
		}
		digest, err := runtimeFileDigest(filepath.Join(root, path))
		if err != nil || digest != file.SHA256 {
			return runtimeManifest{}, errInvalidFrame
		}
	}
	return manifest, nil
}
