//go:build darwin && !cgo

package connector

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

func allowedJournalAncestorSymlink(path string) bool {
	if filepath.Clean(path) != "/var" {
		return false
	}
	resolved, err := filepath.EvalSymlinks(path)
	return err == nil && filepath.Clean(resolved) == "/private/var"
}

func secureJournalPath(string) error { return nil }

func validateJournalFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("stat journal file: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("journal path %q must not be a symlink", path)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("journal path %q is not a regular file", path)
	}
	return nil
}

func validateJournalFileHandle(file *os.File) error {
	if file == nil {
		return fmt.Errorf("journal file handle must not be nil")
	}
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("stat opened journal file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("opened journal path %q is not a regular file", file.Name())
	}
	return nil
}

func secureJournalFile(file *os.File) error {
	if file == nil {
		return fmt.Errorf("journal file handle must not be nil")
	}
	return clearDarwinJournalACLByPath(file, file.Name())
}

func validateJournalDirectoryRoot(root *os.Root, path string, info os.FileInfo) error {
	if root == nil || info == nil || !info.IsDir() {
		return fmt.Errorf("journal parent path %q is not a directory", path)
	}
	hasACL, err := darwinJournalHasExtendedACL(path)
	if err != nil {
		return err
	}
	if hasACL {
		return fmt.Errorf("journal path %q has an extended ACL", path)
	}
	return nil
}

func secureJournalDirectoryRoot(root *os.Root, path string) error {
	if root == nil {
		return fmt.Errorf("journal directory root must not be nil")
	}
	directory, err := root.OpenFile(".", os.O_RDONLY, 0)
	if err != nil {
		return fmt.Errorf("open journal directory handle %q: %w", path, err)
	}
	defer directory.Close()
	info, err := directory.Stat()
	if err != nil {
		return fmt.Errorf("stat journal directory handle %q: %w", path, err)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && uint32(os.Geteuid()) != stat.Uid {
		return nil
	}
	return clearDarwinJournalACLByPath(directory, path)
}

func validateJournalDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("stat journal directory: %w", err)
	}
	return validateJournalDirectoryInfo(path, info)
}

func validateJournalDirectoryInfo(path string, info os.FileInfo) error {
	if info == nil {
		return fmt.Errorf("journal parent path %q is not a directory", path)
	}
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

func clearDarwinJournalACLByPath(file *os.File, path string) error {
	if file == nil {
		return fmt.Errorf("journal path handle must not be nil")
	}
	before, err := file.Stat()
	if err != nil {
		return fmt.Errorf("stat opened journal path %q: %w", path, err)
	}
	hasACL, err := darwinJournalHasExtendedACL(path)
	if err != nil {
		return err
	}
	if !hasACL {
		return nil
	}
	if err := exec.Command("/bin/chmod", "-N", path).Run(); err != nil {
		return fmt.Errorf("clear journal ACL %q: %w", path, err)
	}
	after, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("stat journal path %q after ACL update: %w", path, err)
	}
	if !os.SameFile(before, after) {
		return fmt.Errorf("journal path %q changed while clearing ACL", path)
	}
	return nil
}

func darwinJournalHasExtendedACL(path string) (bool, error) {
	output, err := exec.Command("/bin/ls", "-lde", path).Output()
	if err != nil {
		return false, fmt.Errorf("inspect journal ACL %q: %w", path, err)
	}
	line := strings.SplitN(string(output), "\n", 2)[0]
	fields := strings.Fields(line)
	return len(fields) > 0 && strings.Contains(fields[0], "+"), nil
}
