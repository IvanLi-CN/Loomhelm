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
// only the fixtures' temporary directories. Each go test invocation owns new
// fixtures, including the normal, race and shuffled verification rounds.
func (b *EntrypointBinary) Run(m *testing.M, companions ...*EntrypointBinary) int {
	code := m.Run()
	for _, binary := range append([]*EntrypointBinary{b}, companions...) {
		if err := binary.cleanup(); err != nil {
			fmt.Fprintf(os.Stderr, "clean up entrypoint binary: %v\n", err)
			code = 1
		}
	}
	return code
}

func (b *EntrypointBinary) cleanup() error {
	if b.directory == "" {
		return nil
	}
	return os.RemoveAll(b.directory)
}
