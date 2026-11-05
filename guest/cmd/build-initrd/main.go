// Command build-initrd writes one session's guest initrd.
//
// It replaces `executor/vm/scripts/build-guest-initrd.sh` everywhere that
// script cannot run: the script uses BSD `stat -f`, so it is macOS-only, and
// it shells out to `go build`, so it needs a toolchain on the machine running
// the daemon. This builder is a single portable binary that takes an already
// built guest init beside it, which is exactly how the Linux package ships it
// (`resources/guest/{build-initrd,init}`).
//
// The contract with `guest-vm-session.ts` is unchanged and is what makes this
// a drop-in for `guestInitrdBuilderPath`:
//
//	build-initrd --output <absolute> [--codex-auth <absolute>] --bootstrap-token-stdin
//
// The bootstrap token is read from standard input and never appears in argv,
// in a log, or in an error. The archive is written to a fresh file in an
// owner-only parent and is one-use session material the VM owner removes.
//
// Output is deterministic: every archive member carries mtime 0 and uid/gid 0,
// members are emitted in a fixed order, and the gzip header has no timestamp,
// so the same guest binary and the same token always produce the same bytes.
package main

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const (
	bootstrapTokenChars   = 43
	codexAuthMaxBytes     = 1 << 20
	initArchiveName       = "init"
	initArchiveMode       = 0o500
	tokenArchiveName      = "etc/nessie/bootstrap-token"
	codexAuthArchiveName  = "etc/nessie/codex-auth.json"
	bootArgsArchiveName   = "etc/nessie/boot-args"
	bootArgsMaxBytes      = 512
	privateArchiveMode    = 0o400
	privateDirectoryMode  = 0o700
	defaultGuestInitName  = "init"
	initrdTemporaryPrefix = ".nessie-guest-initrd-"
)

type options struct {
	bootArgs  string
	codexAuth string
	initPath  string
	output    string
	readToken bool
}

func usage() error {
	return errors.New(
		"usage: build-initrd --output <absolute-path> [--codex-auth <absolute-path>] " +
			"[--init <absolute-path>] [--boot-args <kernel-arguments>] --bootstrap-token-stdin")
}

// The per-session kernel arguments, for a host whose firmware supplies no
// command line: Hyper-V's generation 2 firmware boots \EFI\BOOT\BOOTX64.EFI
// with empty UEFI load options, so the kernel's only line is the static one
// compiled into it and this session's runtime-manifest digest has nowhere else
// to travel. The guest joins the two when the built-in line says
// `nessie.args=initrd`. Nothing secret goes here — the token keeps its own
// member — and the value is validated rather than copied blind, because it
// becomes a kernel command line.
func validBootArgs(value string) bool {
	if value == "" || len(value) > bootArgsMaxBytes {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character > 0x7e {
			return false
		}
	}
	return true
}

func parseArguments(argv []string) (options, error) {
	var parsed options
	for index := 0; index < len(argv); index++ {
		switch argv[index] {
		case "--bootstrap-token-stdin":
			parsed.readToken = true
		case "--boot-args":
			if index+1 >= len(argv) || !validBootArgs(argv[index+1]) {
				return options{}, usage()
			}
			parsed.bootArgs = argv[index+1]
			index++
		case "--output", "--codex-auth", "--init":
			if index+1 >= len(argv) {
				return options{}, usage()
			}
			value := argv[index+1]
			index++
			if !filepath.IsAbs(value) {
				return options{}, usage()
			}
			switch argv[index-1] {
			case "--output":
				parsed.output = value
			case "--codex-auth":
				parsed.codexAuth = value
			default:
				parsed.initPath = value
			}
		default:
			return options{}, usage()
		}
	}
	if parsed.output == "" || !parsed.readToken {
		return options{}, usage()
	}
	return parsed, nil
}

// The token is the guest's one-use proof of this exact VM, so it is validated
// here rather than being copied blind: 43 canonical base64url characters
// decoding to 32 bytes, which is what the guest re-checks on boot.
func readBootstrapToken(reader io.Reader) (string, error) {
	raw, err := io.ReadAll(io.LimitReader(reader, bootstrapTokenChars+2))
	if err != nil {
		return "", errors.New("missing bootstrap token")
	}
	token := string(bytes.TrimRight(raw, "\r\n"))
	if len(token) != bootstrapTokenChars {
		return "", errors.New("invalid bootstrap token")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != token {
		return "", errors.New("invalid bootstrap token")
	}
	return token, nil
}

func ownerPrivateFile(path string, maxBytes int64, modes []os.FileMode) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s must be an ordinary file", filepath.Base(path))
	}
	if err := assertCallerOwnsPrivateFile(info, modes); err != nil {
		return nil, fmt.Errorf("%s %s", filepath.Base(path), err)
	}
	if info.Size() == 0 || info.Size() > maxBytes {
		return nil, fmt.Errorf("%s has an invalid size", filepath.Base(path))
	}
	return os.ReadFile(path)
}

func assertPrivateParent(output string) (string, error) {
	if _, err := os.Lstat(output); err == nil {
		return "", errors.New("initrd output already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	parent := filepath.Dir(output)
	info, err := os.Lstat(parent)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", errors.New("initrd parent must be an owner-only directory")
	}
	if err := assertCallerOwnsPrivateDirectory(info); err != nil {
		return "", fmt.Errorf("initrd parent %s", err)
	}
	return parent, nil
}

func guestInitPath(parsed options) (string, error) {
	if parsed.initPath != "" {
		return parsed.initPath, nil
	}
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(resolved), defaultGuestInitName), nil
}

func build(parsed options, token string) ([]byte, error) {
	initPath, err := guestInitPath(parsed)
	if err != nil {
		return nil, err
	}
	guest, err := os.ReadFile(initPath)
	if err != nil {
		return nil, fmt.Errorf("the guest init is not installed at %s", initPath)
	}
	if len(guest) == 0 {
		return nil, errors.New("the guest init is empty")
	}
	members := []cpioMember{
		cpioFile(initArchiveName, initArchiveMode, guest),
		cpioDir("etc", privateDirectoryMode),
		cpioDir("etc/nessie", privateDirectoryMode),
		cpioFile(tokenArchiveName, privateArchiveMode, []byte(token)),
	}
	if parsed.bootArgs != "" {
		members = append(members, cpioFile(bootArgsArchiveName, privateArchiveMode, []byte(parsed.bootArgs)))
	}
	if parsed.codexAuth != "" {
		profile, err := ownerPrivateFile(parsed.codexAuth, codexAuthMaxBytes,
			[]os.FileMode{0o400, 0o600})
		if err != nil {
			return nil, err
		}
		members = append(members, cpioFile(codexAuthArchiveName, privateArchiveMode, profile))
	}
	var compressed bytes.Buffer
	writer, err := gzip.NewWriterLevel(&compressed, gzip.BestSpeed)
	if err != nil {
		return nil, err
	}
	if err := writeCpioArchive(writer, members); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return compressed.Bytes(), nil
}

func run(argv []string, stdin io.Reader) error {
	parsed, err := parseArguments(argv)
	if err != nil {
		return err
	}
	parent, err := assertPrivateParent(parsed.output)
	if err != nil {
		return err
	}
	token, err := readBootstrapToken(stdin)
	if err != nil {
		return err
	}
	archive, err := build(parsed, token)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(parent, initrdTemporaryPrefix)
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if err := temporary.Chmod(0o600); err != nil {
		return err
	}
	if _, err := temporary.Write(archive); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), parsed.output)
}

func main() {
	if err := run(os.Args[1:], os.Stdin); err != nil {
		// The message never contains the token: every token failure is the
		// constant "invalid bootstrap token".
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
