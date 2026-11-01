//go:build windows

package artifacts

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

var errStoredArtifactReparsePoint = errors.New("stored artifact is a reparse point")

func openStoredArtifactFile(path string) (*os.File, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(
		name,
		syscall.GENERIC_READ,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil,
		syscall.OPEN_EXISTING,
		syscall.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(handle), path)
	if file == nil {
		_ = syscall.CloseHandle(handle)
		return nil, errors.New("create stored artifact file wrapper")
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		_ = file.Close()
		return nil, errStoredArtifactReparsePoint
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, fmt.Errorf("stored artifact is not a regular file: %w", ErrIntegrity)
	}
	return file, nil
}

func isStoredArtifactSymlinkError(err error) bool {
	return errors.Is(err, errStoredArtifactReparsePoint)
}

func artifactStagingIdentity(path string, _ os.FileInfo) (string, error) {
	file, err := openStoredArtifactFile(path)
	if err != nil {
		return "", fmt.Errorf("open artifact staging object for identity: %w", ErrStoreUnavailable)
	}
	defer file.Close()
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &info); err != nil {
		return "", fmt.Errorf("read artifact staging identity: %w", ErrStoreUnavailable)
	}
	return fmt.Sprintf("%d:%d:%d", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow), nil
}
