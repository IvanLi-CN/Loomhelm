//go:build windows

package connector

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

func configureProcessGroup(*exec.Cmd) {}

func killProcessGroup(command *exec.Cmd) error {
	if command == nil || command.Process == nil {
		return nil
	}
	// taskkill's tree mode terminates descendants spawned by the app-server,
	// which a plain Process.Kill would leave running on Windows.
	systemRoot := os.Getenv("SystemRoot")
	if systemRoot == "" {
		return fmt.Errorf("SystemRoot is not set")
	}
	taskkill := filepath.Join(systemRoot, "System32", "taskkill.exe")
	return exec.Command(taskkill, "/PID", strconv.Itoa(command.Process.Pid), "/T", "/F").Run()
}
