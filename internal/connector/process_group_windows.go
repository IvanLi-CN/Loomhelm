//go:build windows

package connector

import "os/exec"

func configureProcessGroup(*exec.Cmd) {}

func killProcessGroup(*exec.Cmd) error { return exec.ErrNotFound }
