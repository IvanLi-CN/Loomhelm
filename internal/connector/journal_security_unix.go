//go:build !windows && !darwin

package connector

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
)

func secureJournalPath(string) error { return nil }

func validateJournalFile(string) error { return nil }

func validateJournalFileHandle(*os.File) error { return nil }

func secureJournalFile(*os.File) error { return nil }

func validateJournalDirectoryRoot(*os.Root, string, os.FileInfo) error { return nil }

func secureJournalDirectoryRoot(*os.Root, string) error { return nil }

func validateJournalDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("stat journal directory: %w", err)
	}
	return validateJournalDirectoryInfo(path, info)
}

func validateJournalDirectoryInfo(path string, info os.FileInfo) error {
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("journal parent path %q must not be a symlink", path)
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

func allowedJournalAncestorSymlink(path string) bool {
	if runtime.GOOS != "darwin" || filepath.Clean(path) != "/var" {
		return false
	}
	resolved, err := filepath.EvalSymlinks(path)
	return err == nil && filepath.Clean(resolved) == "/private/var"
}
