//go:build !windows

package connector

import (
	"fmt"
	"os"
	"syscall"
)

func secureJournalPath(string) error { return nil }

func validateJournalDirectory(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("stat journal directory: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("journal parent path %q is not a directory", path)
	}
	if info.Mode().Perm() != 0o700 {
		return fmt.Errorf("journal parent directory %q must have mode 0700, got %04o", path, info.Mode().Perm())
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && uint32(os.Geteuid()) != stat.Uid {
		return fmt.Errorf("journal parent directory %q is not owned by the current user", path)
	}
	return nil
}
