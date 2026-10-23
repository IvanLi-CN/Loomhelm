//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package connector

import (
	"fmt"
	"os"
	"syscall"
)

func lockJournalFile(file *os.File) error {
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("journal is already owned or cannot be locked: %w", err)
	}
	return nil
}

func unlockJournalFile(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
}
