package testsupport

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func entrypointModule(t *testing.T, source string) string {
	t.Helper()
	root := t.TempDir()
	for name, content := range map[string]string{
		"go.mod":  "module entrypoint-fixture\n\ngo 1.24\n",
		"main.go": source,
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestEntrypointBinaryOutlivesTestCleanup(t *testing.T) {
	root := entrypointModule(t, "package main\nfunc main() {}\n")
	binary := NewEntrypointBinary(root, ".")
	t.Cleanup(func() {
		if err := binary.cleanup(); err != nil {
			t.Error(err)
		}
	})
	var first string
	t.Run("first consumer", func(t *testing.T) {
		first = binary.Path(t)
	})
	if info, err := os.Stat(first); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("first consumer cleanup removed shared binary: %v", err)
	}
	// A second consumer must not run go build again, even after the first
	// consumer has finished. A rebuild would fail on this changed input.
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("invalid Go source"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Run("second consumer", func(t *testing.T) {
		if got := binary.Path(t); got != first {
			t.Fatalf("binary changed between consumers: %q != %q", got, first)
		}
	})
	if err := binary.cleanup(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(first); !os.IsNotExist(err) {
		t.Fatalf("fixture cleanup left shared binary behind: %v", err)
	}
}

func TestEntrypointBinaryConcurrentConsumers(t *testing.T) {
	binary := NewEntrypointBinary(entrypointModule(t, "package main\nfunc main() {}\n"), ".")
	t.Cleanup(func() {
		if err := binary.cleanup(); err != nil {
			t.Error(err)
		}
	})
	var consumers sync.WaitGroup
	paths := make(chan string, 8)
	for range 8 {
		consumers.Go(func() { paths <- binary.Path(t) })
	}
	consumers.Wait()
	close(paths)
	var first string
	for path := range paths {
		if first == "" {
			first = path
		}
		if path != first {
			t.Fatalf("concurrent consumers received different binaries: %q != %q", path, first)
		}
	}
}

func TestEntrypointBinaryRetainsBuildFailure(t *testing.T) {
	root := entrypointModule(t, "invalid Go source")
	binary := NewEntrypointBinary(root, ".")
	t.Cleanup(func() {
		if err := binary.cleanup(); err != nil {
			t.Error(err)
		}
	})
	_, firstErr := binary.build()
	if firstErr == nil {
		t.Fatal("invalid entrypoint unexpectedly built")
	}
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package main\nfunc main() {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := binary.build(); err != firstErr {
		t.Fatalf("build failure was retried or lost: got %v, want %v", err, firstErr)
	}
}
