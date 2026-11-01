//go:build windows

package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"
)

const (
	connectorBootstrapLockPollInterval = 25 * time.Millisecond
	connectorLockExclusive             = 0x00000002
	connectorLockFailImmediately       = 0x00000001
	connectorLockViolation             = syscall.Errno(33)
	connectorFileFlagWriteThrough      = 0x80000000
)

var (
	connectorLockFileEx   = syscall.NewLazyDLL("kernel32.dll").NewProc("LockFileEx")
	connectorUnlockFileEx = syscall.NewLazyDLL("kernel32.dll").NewProc("UnlockFileEx")
)

func openConnectorBootstrapLock(ctx context.Context, path string) (*os.File, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
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
	if connectorStatePermissionsTooBroad(info) {
		_ = file.Close()
		return nil, errors.New("Connector bootstrap lock permissions are too broad")
	}
	if err := secureConnectorStateFile(file); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("secure Connector bootstrap lock: %w", err)
	}
	if err := validateConnectorStateFileHandle(file); err != nil {
		_ = file.Close()
		return nil, err
	}
	for {
		if err := ctx.Err(); err != nil {
			_ = file.Close()
			return nil, err
		}
		overlap := new(syscall.Overlapped)
		result, _, callErr := connectorLockFileEx.Call(uintptr(file.Fd()), connectorLockExclusive|connectorLockFailImmediately, 0, 1, 0, uintptr(unsafe.Pointer(overlap)))
		if result != 0 {
			return file, nil
		}
		if !errors.Is(callErr, connectorLockViolation) {
			_ = file.Close()
			return nil, fmt.Errorf("acquire Connector bootstrap lock: %w", callErr)
		}
		timer := time.NewTimer(connectorBootstrapLockPollInterval)
		select {
		case <-timer.C:
		case <-ctx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			_ = file.Close()
			return nil, ctx.Err()
		}
	}
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

func syncConnectorStateDirectory(path string) (syncErr error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return fmt.Errorf("format Connector state directory path: %w", err)
	}
	handle, err := syscall.CreateFile(
		name,
		syscall.GENERIC_WRITE,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil,
		syscall.OPEN_EXISTING,
		syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT|connectorFileFlagWriteThrough,
		0,
	)
	if err != nil {
		return fmt.Errorf("open Connector state directory for sync: %w", err)
	}
	defer func() {
		if closeErr := syscall.CloseHandle(handle); closeErr != nil {
			syncErr = errors.Join(syncErr, fmt.Errorf("close Connector state directory sync handle: %w", closeErr))
		}
	}()
	if err := syscall.FlushFileBuffers(handle); err != nil {
		return fmt.Errorf("flush Connector state directory: %w", err)
	}
	return nil
}
