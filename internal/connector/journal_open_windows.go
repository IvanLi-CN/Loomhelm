//go:build windows

package connector

import (
	"fmt"
	"os"
)

func prepareJournalDirectories(path string) ([]string, error) {
	newDirectories, err := missingJournalDirectories(path)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return nil, fmt.Errorf("create journal directory: %w", err)
	}
	for _, directory := range newDirectories {
		if err := os.Chmod(directory, 0o700); err != nil {
			return nil, fmt.Errorf("secure journal directory permissions: %w", err)
		}
		if err := secureJournalPath(directory); err != nil {
			return nil, fmt.Errorf("secure journal directory ACL: %w", err)
		}
	}
	return newDirectories, nil
}

func openJournalFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o600)
}
