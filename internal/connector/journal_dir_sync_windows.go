//go:build windows

package connector

// Windows does not provide a portable directory-handle equivalent of Unix
// fsync. The journal file's FlushFileBuffers call remains the durability
// boundary; directory entry persistence is best effort on this platform.
func syncJournalDirectory(string) error { return nil }
