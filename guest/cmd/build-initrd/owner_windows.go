//go:build windows

package main

import "os"

// Windows has neither a uid nor mode bits: `os.FileInfo.Mode().Perm()` reports
// a synthesized 0666/0444 and `os.Getuid()` reports -1, so the POSIX check
// would refuse every file rather than prove anything about it. Privacy on
// Windows is a DACL, and the executor already proves that one where it belongs:
// the daemon's state root under %LOCALAPPDATA%\Nessie (or
// %ProgramData%\Nessie Executor for the service) is created with a DACL
// granting only its own account, and every read verifies that DACL through
// `executor/native`. This builder only ever writes inside a session directory
// beneath that root, so the check it could make here would be a weaker second
// copy of one already made.
//
// It is stated as its own file rather than as a branch so that the POSIX rule
// stays exactly what it was, and so a reader can see that Windows is a
// deliberate decision rather than an omission.
func assertCallerOwnsPrivateFile(_ os.FileInfo, _ []os.FileMode) error {
	return nil
}

func assertCallerOwnsPrivateDirectory(_ os.FileInfo) error {
	return nil
}
