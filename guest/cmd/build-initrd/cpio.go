package main

import (
	"fmt"
	"io"
)

// The "new ASCII" (newc) cpio format Linux's initramfs unpacker reads: a
// 110-byte header of six magic characters plus thirteen eight-digit hex
// fields, then the NUL-terminated name padded to a four-byte boundary, then
// the payload padded the same way. The archive ends with a zero-length member
// named TRAILER!!!.
//
// It is written by hand rather than pulled from a dependency because the whole
// format is these forty lines, and because determinism here is a property we
// assert rather than inherit: every member gets mtime 0 and uid/gid 0, so the
// only thing that can change the bytes is the guest binary or the token.
const (
	cpioMagic       = "070701"
	cpioTrailerName = "TRAILER!!!"
	cpioRegular     = 0o100000
	cpioDirectory   = 0o040000
)

// mode is the complete st_mode, file-type bits included, so the trailer can
// carry the conventional zero rather than being a special case of a regular
// file.
type cpioMember struct {
	mode    uint32
	name    string
	payload []byte
}

func cpioFile(name string, mode uint32, payload []byte) cpioMember {
	return cpioMember{mode: cpioRegular | mode, name: name, payload: payload}
}

func cpioDir(name string, mode uint32) cpioMember {
	return cpioMember{mode: cpioDirectory | mode, name: name}
}

func writeCpioField(writer io.Writer, value uint32) error {
	_, err := fmt.Fprintf(writer, "%08X", value)
	return err
}

func writeCpioPadding(writer io.Writer, written int) error {
	padding := (4 - (written % 4)) % 4
	if padding == 0 {
		return nil
	}
	_, err := writer.Write(make([]byte, padding))
	return err
}

func writeCpioMember(writer io.Writer, inode uint32, member cpioMember) error {
	if _, err := io.WriteString(writer, cpioMagic); err != nil {
		return err
	}
	// ino, mode, uid, gid, nlink, mtime, filesize, devmajor, devminor,
	// rdevmajor, rdevminor, namesize, check.
	fields := []uint32{
		inode, member.mode, 0, 0, 1, 0, uint32(len(member.payload)),
		0, 0, 0, 0, uint32(len(member.name) + 1), 0,
	}
	for _, field := range fields {
		if err := writeCpioField(writer, field); err != nil {
			return err
		}
	}
	if _, err := io.WriteString(writer, member.name); err != nil {
		return err
	}
	if _, err := writer.Write([]byte{0}); err != nil {
		return err
	}
	if err := writeCpioPadding(writer, 110+len(member.name)+1); err != nil {
		return err
	}
	if len(member.payload) == 0 {
		return nil
	}
	if _, err := writer.Write(member.payload); err != nil {
		return err
	}
	return writeCpioPadding(writer, len(member.payload))
}

func writeCpioArchive(writer io.Writer, members []cpioMember) error {
	for index, member := range members {
		if err := writeCpioMember(writer, uint32(index+1), member); err != nil {
			return err
		}
	}
	return writeCpioMember(writer, uint32(len(members)+1), cpioMember{name: cpioTrailerName})
}
