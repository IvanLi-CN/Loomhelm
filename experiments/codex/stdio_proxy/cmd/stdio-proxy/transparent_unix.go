//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package main

import "syscall"

func runTransparent(path string, args, env []string) error {
	argv := append([]string{path}, args...)
	return syscall.Exec(path, argv, env)
}
