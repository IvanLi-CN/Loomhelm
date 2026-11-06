//go:build windows

package connector

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func prepareJournalDirectories(path string) ([]string, error) {
	root, created, err := openJournalDirectory(path, true)
	if err != nil {
		return nil, err
	}
	if err := root.Close(); err != nil {
		return nil, fmt.Errorf("close journal directory: %w", err)
	}
	return created, nil
}

func openJournalFile(path string) (*os.File, error) {
	root, _, err := openJournalDirectory(filepath.Dir(path), true)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if info, statErr := root.Lstat(filepath.Base(path)); statErr == nil && info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("journal path %q must not be a symlink", path)
	} else if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return nil, fmt.Errorf("stat journal file: %w", statErr)
	}
	validated, err := root.OpenFile(filepath.Base(path), os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open validated journal file: %w", err)
	}
	validatedInfo, err := validated.Stat()
	if err != nil {
		_ = validated.Close()
		return nil, fmt.Errorf("stat validated journal file: %w", err)
	}
	if !validatedInfo.Mode().IsRegular() {
		_ = validated.Close()
		return nil, fmt.Errorf("journal path %q is not a regular file", path)
	}
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		_ = validated.Close()
		return nil, err
	}
	handle, err := syscall.CreateFile(
		name,
		syscall.GENERIC_READ|syscall.GENERIC_WRITE|writeDACAccess,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil,
		syscall.OPEN_ALWAYS,
		syscall.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err != nil {
		_ = validated.Close()
		return nil, err
	}
	file := os.NewFile(uintptr(handle), path)
	if file == nil {
		_ = validated.Close()
		_ = syscall.CloseHandle(handle)
		return nil, errors.New("create journal file wrapper")
	}
	info, err := file.Stat()
	if err != nil {
		_ = validated.Close()
		_ = file.Close()
		return nil, err
	}
	if !info.Mode().IsRegular() {
		_ = validated.Close()
		_ = file.Close()
		return nil, fmt.Errorf("journal path %q is not a regular file", path)
	}
	if !os.SameFile(validatedInfo, info) {
		_ = validated.Close()
		_ = file.Close()
		return nil, fmt.Errorf("journal path %q changed while opening", path)
	}
	if err := validated.Close(); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("close validated journal file: %w", err)
	}
	return file, nil
}

func openJournalDirectory(path string, create bool) (*os.Root, []string, error) {
	anchor, components, err := journalDirectoryPlan(path)
	if err != nil {
		return nil, nil, err
	}
	anchorInfo, err := os.Lstat(anchor)
	if err != nil {
		return nil, nil, fmt.Errorf("stat journal directory anchor: %w", err)
	}
	if anchorInfo.Mode()&os.ModeSymlink != 0 || !anchorInfo.IsDir() {
		return nil, nil, fmt.Errorf("journal directory anchor %q is not a regular directory", anchor)
	}
	root, err := os.OpenRoot(anchor)
	if err != nil {
		return nil, nil, fmt.Errorf("open journal directory anchor: %w", err)
	}
	rootInfo, err := root.Stat(".")
	if err != nil {
		_ = root.Close()
		return nil, nil, fmt.Errorf("stat opened journal directory anchor: %w", err)
	}
	if !os.SameFile(anchorInfo, rootInfo) {
		_ = root.Close()
		return nil, nil, fmt.Errorf("journal directory anchor changed while opening")
	}

	created := make([]string, 0, len(components))
	currentPath := anchor
	for _, component := range components {
		componentPath := filepath.Join(currentPath, component)
		info, statErr := root.Lstat(component)
		wasCreated := false
		if errors.Is(statErr, os.ErrNotExist) && create {
			if mkdirErr := root.Mkdir(component, 0o700); mkdirErr != nil && !errors.Is(mkdirErr, os.ErrExist) {
				_ = root.Close()
				return nil, nil, fmt.Errorf("create journal directory %q: %w", componentPath, mkdirErr)
			}
			info, statErr = root.Lstat(component)
			wasCreated = statErr == nil
		}
		if statErr != nil {
			_ = root.Close()
			return nil, nil, fmt.Errorf("stat journal directory %q: %w", componentPath, statErr)
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			_ = root.Close()
			return nil, nil, fmt.Errorf("journal parent path %q is not a regular directory", componentPath)
		}
		nextRoot, openErr := root.OpenRoot(component)
		if openErr != nil {
			_ = root.Close()
			return nil, nil, fmt.Errorf("open journal directory %q: %w", componentPath, openErr)
		}
		nextInfo, statErr := nextRoot.Stat(".")
		if statErr != nil || !os.SameFile(info, nextInfo) {
			_ = nextRoot.Close()
			_ = root.Close()
			if statErr != nil {
				return nil, nil, fmt.Errorf("verify journal directory %q: %w", componentPath, statErr)
			}
			return nil, nil, fmt.Errorf("journal directory %q changed while opening", componentPath)
		}
		if wasCreated {
			if err := root.Chmod(component, 0o700); err != nil {
				_ = nextRoot.Close()
				_ = root.Close()
				return nil, nil, fmt.Errorf("secure journal directory permissions: %w", err)
			}
			if err := secureJournalDirectoryRoot(nextRoot, componentPath); err != nil {
				_ = nextRoot.Close()
				_ = root.Close()
				return nil, nil, fmt.Errorf("secure journal directory ACL: %w", err)
			}
			created = append(created, componentPath)
		}
		if err := root.Close(); err != nil {
			_ = nextRoot.Close()
			return nil, nil, fmt.Errorf("close journal directory component: %w", err)
		}
		root = nextRoot
		currentPath = componentPath
	}
	finalInfo, err := root.Stat(".")
	if err != nil {
		_ = root.Close()
		return nil, nil, fmt.Errorf("stat opened journal directory: %w", err)
	}
	if err := validateJournalDirectoryRoot(root, currentPath, finalInfo); err != nil {
		_ = root.Close()
		return nil, nil, err
	}
	return root, created, nil
}

func journalDirectoryPlan(path string) (string, []string, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return "", nil, fmt.Errorf("resolve journal directory: %w", err)
	}
	cleanPath := filepath.Clean(absPath)
	if _, err := missingJournalDirectories(cleanPath); err != nil {
		return "", nil, err
	}
	volume := filepath.VolumeName(cleanPath)
	if volume == "" {
		return "", nil, fmt.Errorf("journal directory %q has no volume", cleanPath)
	}
	anchor := volume + string(filepath.Separator)
	relative, err := filepath.Rel(anchor, cleanPath)
	if err != nil {
		return "", nil, fmt.Errorf("relate journal directory to anchor: %w", err)
	}
	if relative == "." {
		return anchor, nil, nil
	}
	return anchor, strings.Split(relative, string(filepath.Separator)), nil
}
