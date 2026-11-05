package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

const (
	guestControlFrameMaxBytes   = 65_536
	guestControlPayloadMaxBytes = 32_768
	guestControlVersion         = 1
)

var errInvalidFrame = errors.New("invalid control frame")

type controlEnvelope struct {
	Kind         string `json:"kind"`
	Payload      []byte `json:"payload"`
	RequestID    string `json:"requestId"`
	SessionToken string `json:"sessionToken,omitempty"`
	Version      int    `json:"version"`
}

func validBootstrapToken(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == 32 && base64.RawURLEncoding.EncodeToString(decoded) == value
}

func deriveEgressToken(bootstrapToken string) (string, error) {
	bootstrap, err := base64.RawURLEncoding.DecodeString(bootstrapToken)
	if err != nil || len(bootstrap) != 32 || !validBootstrapToken(bootstrapToken) {
		return "", errInvalidFrame
	}
	mac := hmac.New(sha256.New, bootstrap)
	_, _ = mac.Write([]byte("nessie-executor-egress-v1"))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func workspaceRequested(commandLine string) bool {
	return strings.Contains(" "+commandLine+" ", " nessie.workspace=1 ")
}

func egressRequested(commandLine string) bool {
	return strings.Contains(" "+commandLine+" ", " nessie.egress=1 ")
}

func runtimeRequested(commandLine string) bool {
	return strings.Contains(" "+commandLine+" ", " nessie.runtime=1 ")
}

// Which share strategy the host configured. Absent means virtiofs, so the
// macOS boot contract is byte-identical to the one that shipped: only a host
// that cannot offer virtio-fs — Firecracker, and Hyper-V after it — says so.
func blockSharesRequested(commandLine string) bool {
	return strings.Contains(" "+commandLine+" ", " nessie.shares=block ")
}

// Whether this boot's per-session kernel arguments live in the initrd rather
// than on the line the firmware supplied. Set only by a host that cannot write
// a per-session command line at all — Hyper-V generation 2, whose firmware
// boots the EFI stub with empty UEFI load options, so the only line the kernel
// has is the one compiled into it.
func initrdBootArgsRequested(commandLine string) bool {
	return strings.Contains(" "+commandLine+" ", " nessie.args=initrd ")
}

func validateEnvelope(envelope controlEnvelope) error {
	if envelope.Version != guestControlVersion || envelope.RequestID == "" || len(envelope.Payload) > guestControlPayloadMaxBytes {
		return errInvalidFrame
	}
	switch envelope.Kind {
	case "hello":
		if len(envelope.Payload) != 0 || !validBootstrapToken(envelope.SessionToken) {
			return errInvalidFrame
		}
	case "request", "response", "close":
		if envelope.SessionToken != "" {
			return errInvalidFrame
		}
	default:
		return errInvalidFrame
	}
	return nil
}

func readControlFrame(reader io.Reader) (controlEnvelope, error) {
	var header [4]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return controlEnvelope{}, err
	}
	length := binary.BigEndian.Uint32(header[:])
	if length > guestControlFrameMaxBytes-4 {
		return controlEnvelope{}, errInvalidFrame
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(reader, body); err != nil {
		return controlEnvelope{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var envelope controlEnvelope
	if err := decoder.Decode(&envelope); err != nil {
		return controlEnvelope{}, errInvalidFrame
	}
	if decoder.More() || decoder.Decode(&struct{}{}) != io.EOF {
		return controlEnvelope{}, errInvalidFrame
	}
	if err := validateEnvelope(envelope); err != nil {
		return controlEnvelope{}, err
	}
	return envelope, nil
}

func writeControlFrame(writer io.Writer, envelope controlEnvelope) error {
	if err := validateEnvelope(envelope); err != nil {
		return err
	}
	body, err := json.Marshal(envelope)
	if err != nil || len(body) > guestControlFrameMaxBytes-4 {
		return errInvalidFrame
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(body)))
	if err := writeAll(writer, header[:]); err != nil {
		return err
	}
	return writeAll(writer, body)
}

func writeAll(writer io.Writer, value []byte) error {
	for len(value) > 0 {
		count, err := writer.Write(value)
		if count > 0 {
			value = value[count:]
		}
		if err != nil {
			return err
		}
		if count == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}
