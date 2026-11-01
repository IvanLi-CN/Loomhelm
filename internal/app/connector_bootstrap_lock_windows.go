//go:build windows

package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

const (
	connectorLockExclusive = 0x00000002
)

var (
	connectorLockFileEx   = syscall.NewLazyDLL("kernel32.dll").NewProc("LockFileEx")
	connectorUnlockFileEx = syscall.NewLazyDLL("kernel32.dll").NewProc("UnlockFileEx")
)

func openConnectorBootstrapLock(path string) (*os.File, error) {
	if err := ensureConnectorCredentialDirectory(filepath.Dir(path)); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("Connector bootstrap lock must not be a symlink")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("inspect Connector bootstrap lock: %w", err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open Connector bootstrap lock: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("inspect Connector bootstrap lock: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		_ = file.Close()
		return nil, errors.New("Connector bootstrap lock must be a regular file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		_ = file.Close()
		return nil, errors.New("Connector bootstrap lock permissions are too broad")
	}
	overlap := new(syscall.Overlapped)
	result, _, callErr := connectorLockFileEx.Call(uintptr(file.Fd()), connectorLockExclusive, 0, 1, 0, uintptr(unsafe.Pointer(overlap)))
	if result == 0 {
		_ = file.Close()
		return nil, fmt.Errorf("acquire Connector bootstrap lock: %w", callErr)
	}
	return file, nil
}

func closeConnectorBootstrapLock(file *os.File) error {
	if file == nil {
		return nil
	}
	overlap := new(syscall.Overlapped)
	result, _, callErr := connectorUnlockFileEx.Call(uintptr(file.Fd()), 0, 0, 1, 0, uintptr(unsafe.Pointer(overlap)))
	if result == 0 {
		return errors.Join(fmt.Errorf("release Connector bootstrap lock: %w", callErr), file.Close())
	}
	return file.Close()
}
