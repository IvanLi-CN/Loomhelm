//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package artifacts

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

func openStoredArtifactFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
}

func isStoredArtifactSymlinkError(err error) bool {
	return errors.Is(err, syscall.ELOOP)
}

func artifactStagingIdentity(_ string, info os.FileInfo) (string, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", fmt.Errorf("read artifact staging identity: %w", ErrStoreUnavailable)
	}
	return fmt.Sprintf("%d:%d", stat.Dev, stat.Ino), nil
}
