package testsupport

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

// EntrypointBinary owns one lazily built executable for a test process. Tests
// share only the immutable executable, never running processes or their state.
type EntrypointBinary struct {
	root      string
	pkg       string
	once      sync.Once
	directory string
	path      string
	err       error
}

func NewEntrypointBinary(root, pkg string) *EntrypointBinary {
	return &EntrypointBinary{root: root, pkg: pkg}
}

func (b *EntrypointBinary) build() (string, error) {
	b.once.Do(func() {
		b.directory, b.err = os.MkdirTemp("", "loomhelm-entrypoint-")
		if b.err != nil {
			return
		}
		name := "entrypoint"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		b.path = filepath.Join(b.directory, name)
		command := exec.Command("go", "build", "-o", b.path, b.pkg)
		command.Dir = b.root
		if output, err := command.CombinedOutput(); err != nil {
			b.err = fmt.Errorf("build %s: %w\n%s", b.pkg, err, output)
		}
	})
	return b.path, b.err
}

func (b *EntrypointBinary) Path(t testing.TB) string {
	t.Helper()
	path, err := b.build()
	if err != nil {
		t.Fatal(err)
	}
	return path
}

// Run keeps the binary alive through every test and its cleanup, then removes
// only this fixture's temporary directory. Each go test invocation owns a new
// fixture, including the normal, race and shuffled verification rounds.
func (b *EntrypointBinary) Run(m *testing.M) int {
	code := m.Run()
	if err := b.cleanup(); err != nil {
		fmt.Fprintf(os.Stderr, "clean up entrypoint binary: %v\n", err)
		return 1
	}
	return code
}

func (b *EntrypointBinary) cleanup() error {
	if b.directory == "" {
		return nil
	}
	return os.RemoveAll(b.directory)
}
