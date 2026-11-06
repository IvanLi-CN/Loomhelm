#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../../../.." && pwd)
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/loomhelm-r01-build.XXXXXX")
trap 'rm -rf "$build_dir"' EXIT HUP INT TERM

cd "$repo_dir"
go test -count=1 ./experiments/codex/stdio_proxy/...
go build -o "$build_dir/stdio-proxy" ./experiments/codex/stdio_proxy/cmd/stdio-proxy

printf 'wrapper_sha256='
shasum -a 256 "$build_dir/stdio-proxy" | awk '{print $1}'
printf 'repository_sha='
git rev-parse HEAD
printf 'prototype_result=passed\n'
