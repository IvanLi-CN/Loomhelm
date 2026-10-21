//go:build windows

package connector

import "os"

func lockJournalFile(*os.File) error { return nil }

func unlockJournalFile(*os.File) error { return nil }
