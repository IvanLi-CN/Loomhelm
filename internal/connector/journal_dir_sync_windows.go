//go:build windows

package connector

// Windows does not provide a portable, reliable directory-handle flush
// equivalent to Unix fsync. Journal records are flushed through the file
// handle; directory creation must not make a new journal unopenable.

func syncJournalDirectory(string) error { return nil }
