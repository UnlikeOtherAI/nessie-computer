package main

import "io"

const (
	guestEgressPort     = 49_153
	guestEgressMagic    = "NEXG"
	guestEgressVersion  = byte(1)
	guestEgressPreludeN = 48
)

// writeGuestEgressPrelude proves that this stream belongs to the one VM
// session. It is not a control frame and intentionally carries no bootstrap
// token, request id, executable operation, or policy value.
func writeGuestEgressPrelude(writer io.Writer, sessionToken string) error {
	if !validBootstrapToken(sessionToken) {
		return errInvalidFrame
	}
	prelude := make([]byte, 0, guestEgressPreludeN)
	prelude = append(prelude, guestEgressMagic...)
	prelude = append(prelude, guestEgressVersion)
	prelude = append(prelude, sessionToken...)
	return writeAll(writer, prelude)
}
