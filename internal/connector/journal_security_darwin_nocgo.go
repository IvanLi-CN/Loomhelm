//go:build darwin && !cgo

package connector

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

var errDarwinACLRequiresCgo = errors.New("macOS journal ACL handling requires a cgo-enabled build")

func allowedJournalAncestorSymlink(path string) bool {
	if filepath.Clean(path) != "/var" {
		return false
	}
	resolved, err := filepath.EvalSymlinks(path)
	return err == nil && filepath.Clean(resolved) == "/private/var"
}

func secureJournalPath(string) error { return errDarwinACLRequiresCgo }

func validateJournalFile(string) error { return errDarwinACLRequiresCgo }

func validateJournalFileHandle(*os.File) error { return errDarwinACLRequiresCgo }

func secureJournalFile(*os.File) error { return errDarwinACLRequiresCgo }

func validateJournalDirectoryRoot(*os.Root, string, os.FileInfo) error {
	return errDarwinACLRequiresCgo
}

func secureJournalDirectoryRoot(*os.Root, string) error { return errDarwinACLRequiresCgo }

func validateJournalDirectory(path string) error {
	return fmt.Errorf("validate journal directory %q: %w", path, errDarwinACLRequiresCgo)
}

func validateJournalDirectoryInfo(path string, info os.FileInfo) error {
	if info == nil || !info.IsDir() {
		return fmt.Errorf("journal parent path %q is not a directory", path)
	}
	return errDarwinACLRequiresCgo
}
