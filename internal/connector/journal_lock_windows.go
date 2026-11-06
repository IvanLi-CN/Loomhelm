//go:build windows

package connector

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

const (
	lockfileExclusiveLock   = 0x00000002
	lockfileFailImmediately = 0x00000001
)

var (
	lockFileEx   = syscall.NewLazyDLL("kernel32.dll").NewProc("LockFileEx")
	unlockFileEx = syscall.NewLazyDLL("kernel32.dll").NewProc("UnlockFileEx")
)

func lockJournalFile(file *os.File) error {
	overlap := new(syscall.Overlapped)
	result, _, callErr := lockFileEx.Call(uintptr(file.Fd()), lockfileExclusiveLock|lockfileFailImmediately, 0, 1, 0, uintptr(unsafe.Pointer(overlap)))
	if result == 0 {
		return fmt.Errorf("lock journal file: %w", callErr)
	}
	return nil
}

func unlockJournalFile(file *os.File) error {
	overlap := new(syscall.Overlapped)
	result, _, callErr := unlockFileEx.Call(uintptr(file.Fd()), 0, 0, 1, 0, uintptr(unsafe.Pointer(overlap)))
	if result == 0 {
		return fmt.Errorf("unlock journal file: %w", callErr)
	}
	return nil
}
