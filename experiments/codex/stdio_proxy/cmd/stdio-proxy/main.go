package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"

	stdioproxy "github.com/IvanLi-CN/Loomhelm/experiments/codex/stdio_proxy"
)

func main() {
	childPath := os.Getenv("LOOMHELM_STDIO_PROXY_REAL_CLI")
	if err := stdioproxy.ValidateChildPath(childPath, ""); err != nil {
		fatal(err)
	}

	childArgs := append([]string(nil), os.Args[1:]...)
	if !isAppServerInvocation(childArgs) {
		if err := runTransparent(childPath, childArgs, os.Environ()); err != nil {
			exitFromChildError(err)
		}
		return
	}

	socketPath := os.Getenv("LOOMHELM_STDIO_PROXY_SOCKET")
	if socketPath == "" {
		fatal(fmt.Errorf("LOOMHELM_STDIO_PROXY_SOCKET must be set for app-server mode"))
	}
	if !filepath.IsAbs(socketPath) {
		fatal(fmt.Errorf("LOOMHELM_STDIO_PROXY_SOCKET must be absolute"))
	}

	maxFrameBytes, err := positiveEnv("LOOMHELM_STDIO_PROXY_MAX_FRAME_BYTES", 0)
	if err != nil {
		fatal(err)
	}
	queueSize, err := positiveEnv("LOOMHELM_STDIO_PROXY_BRIDGE_QUEUE", 0)
	if err != nil {
		fatal(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	config := stdioproxy.Config{
		ChildPath:       childPath,
		ChildArgs:       childArgs,
		ChildEnv:        stdioproxy.ChildEnvironment(os.Environ(), childPath),
		SocketPath:      socketPath,
		DesktopIn:       os.Stdin,
		DesktopOut:      os.Stdout,
		ChildStderr:     os.Stderr,
		MaxFrameBytes:   maxFrameBytes,
		BridgeQueueSize: queueSize,
		Logger:          slog.New(slog.NewTextHandler(os.Stderr, nil)),
	}
	if err := stdioproxy.Run(ctx, config); err != nil {
		exitFromChildError(err)
	}
}

func isAppServerInvocation(args []string) bool {
	for _, arg := range args {
		if arg == "app-server" {
			return true
		}
	}
	return false
}

func positiveEnv(key string, fallback int) (int, error) {
	raw, ok := os.LookupEnv(key)
	if !ok || raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return value, nil
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "stdio proxy: %v\n", err)
	os.Exit(2)
}

func exitFromChildError(err error) {
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		if status, ok := exitError.ProcessState.Sys().(syscall.WaitStatus); ok {
			if status.Signaled() {
				os.Exit(128 + int(status.Signal()))
			}
			if status.Exited() {
				os.Exit(status.ExitStatus())
			}
		}
		if code := exitError.ExitCode(); code >= 0 {
			os.Exit(code)
		}
	}
	fmt.Fprintf(os.Stderr, "stdio proxy: %v\n", err)
	os.Exit(1)
}
