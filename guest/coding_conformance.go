package main

import (
	"errors"
	"syscall"
)

func codingSandboxDenied(err error) bool {
	return errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EPERM)
}
