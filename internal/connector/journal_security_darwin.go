//go:build darwin && cgo

package connector

/*
#cgo darwin CFLAGS: -D_DARWIN_C_SOURCE
#include <errno.h>
#include <sys/acl.h>

static int loomhelm_acl_state(int fd) {
	errno = 0;
	acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
	if (acl == NULL) {
		if (errno == ENOENT) {
			return 0;
		}
		return -errno;
	}
	acl_entry_t entry = NULL;
	int entry_result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
	if (entry_result < 0) {
		int code = errno;
		acl_free(acl);
		return -code;
	}
	acl_free(acl);
	return entry_result == 0 ? 0 : 1;
}

static int loomhelm_clear_acl(int fd) {
	acl_t acl = acl_init(0);
	if (acl == NULL) {
		return errno;
	}
	int result = acl_set_fd_np(fd, acl, ACL_TYPE_EXTENDED);
	acl_free(acl);
	if (result == 0 || errno == ENOENT) {
		return 0;
	}
	return errno;
}
*/
import "C"

import (
	"fmt"
	"os"
	"path/filepath"
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

func validateJournalFile(string) error { return nil }

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
	return validateDarwinJournalACL(file, file.Name())
}

func secureJournalFile(file *os.File) error {
	if file == nil {
		return fmt.Errorf("journal file handle must not be nil")
	}
	if err := clearDarwinJournalACL(file, file.Name()); err != nil {
		return err
	}
	return nil
}

func validateJournalDirectoryRoot(root *os.Root, path string, info os.FileInfo) error {
	if root == nil || info == nil || !info.IsDir() {
		return fmt.Errorf("journal parent path %q is not a directory", path)
	}
	directory, err := root.OpenFile(".", os.O_RDONLY, 0)
	if err != nil {
		return fmt.Errorf("open journal directory handle %q: %w", path, err)
	}
	defer directory.Close()
	return validateDarwinJournalACL(directory, path)
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
	return clearDarwinJournalACL(directory, path)
}

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

func validateDarwinJournalACL(file *os.File, path string) error {
	state := int(C.loomhelm_acl_state(C.int(file.Fd())))
	if state < 0 {
		return fmt.Errorf("inspect journal ACL %q: %w", path, syscall.Errno(-state))
	}
	if state != 0 {
		return fmt.Errorf("journal path %q has an extended ACL", path)
	}
	return nil
}

func clearDarwinJournalACL(file *os.File, path string) error {
	if code := int(C.loomhelm_clear_acl(C.int(file.Fd()))); code != 0 {
		return fmt.Errorf("clear journal ACL %q: %w", path, syscall.Errno(code))
	}
	return nil
}
