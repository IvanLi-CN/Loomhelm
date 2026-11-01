//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func openConnectorBootstrapLock(path string) (*os.File, error) {
	if err := ensureConnectorCredentialDirectory(filepath.Dir(path)); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open Connector bootstrap lock: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("inspect Connector bootstrap lock: %w", err)
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, errors.New("Connector bootstrap lock must be a regular file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		_ = file.Close()
		return nil, errors.New("Connector bootstrap lock permissions are too broad")
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("acquire Connector bootstrap lock: %w", err)
	}
	return file, nil
}

func closeConnectorBootstrapLock(file *os.File) error {
	if file == nil {
		return nil
	}
	return errors.Join(syscall.Flock(int(file.Fd()), syscall.LOCK_UN), file.Close())
}
