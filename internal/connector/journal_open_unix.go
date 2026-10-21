//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package connector

import (
	"os"
	"syscall"
)

func openJournalFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND|syscall.O_NOFOLLOW, 0o600)
}
