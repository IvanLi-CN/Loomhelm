#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../../../.." && pwd)
: "${LOOMHELM_R01_STAGE_MANIFEST:?set LOOMHELM_R01_STAGE_MANIFEST to the retained candidate manifest}"

manifest=$LOOMHELM_R01_STAGE_MANIFEST
desktop=${LOOMHELM_R01_DESKTOP_EXECUTABLE:-/Applications/ChatGPT.app/Contents/MacOS/ChatGPT}
test -f "$manifest"
test -x "$desktop"

manifest_value() {
    key=$1
    awk -F= -v wanted="$key" '$1 == wanted {sub(/^[^=]*=/, ""); print; exit}' "$manifest"
}

source_sha=$(manifest_value source_sha)
wrapper=$(manifest_value wrapper_path)
wrapper_sha=$(manifest_value wrapper_sha256)
real_cli=$(manifest_value real_cli_path)
real_cli_sha=$(manifest_value real_cli_sha256)
test -n "$source_sha"
test -n "$wrapper"
test -n "$wrapper_sha"
test -n "$real_cli"
test -n "$real_cli_sha"
if [ -n "$(git -C "$repo_dir" status --porcelain --untracked-files=all)" ]; then
    printf '%s\n' 'refusing to verify a candidate while the repository is dirty' >&2
    exit 2
fi
test -x "$wrapper"
test -f "$real_cli"
test -x "$real_cli"
test "$(shasum -a 256 "$wrapper" | awk '{print $1}')" = "$wrapper_sha"
test "$(shasum -a 256 "$real_cli" | awk '{print $1}')" = "$real_cli_sha"

desktop_rows=$(ps -axo pid=,ppid=,command= | awk -v target="$desktop" '$3 == target {print $1 ":" $2}')
desktop_count=$(printf '%s\n' "$desktop_rows" | awk 'NF {count += 1} END {print count + 0}')
if [ "$desktop_count" -ne 1 ]; then
    printf 'expected exactly one Desktop process at %s; found %s\n' "$desktop" "$desktop_count" >&2
    exit 2
fi

desktop_pid=$(printf '%s\n' "$desktop_rows" | cut -d: -f1)
wrapper_rows=$(ps -axo pid=,ppid=,command= | awk -v target="$wrapper" '$3 == target {print $1 ":" $2}')
wrapper_count=$(printf '%s\n' "$wrapper_rows" | awk 'NF {count += 1} END {print count + 0}')
if [ "$wrapper_count" -ne 1 ]; then
    printf 'expected exactly one retained wrapper process at %s; found %s\n' "$wrapper" "$wrapper_count" >&2
    exit 2
fi

wrapper_pid=$(printf '%s\n' "$wrapper_rows" | cut -d: -f1)
wrapper_parent=$(printf '%s\n' "$wrapper_rows" | cut -d: -f2)
if [ "$wrapper_parent" != "$desktop_pid" ]; then
    printf 'wrapper parent pid %s does not match Desktop pid %s\n' "$wrapper_parent" "$desktop_pid" >&2
    exit 2
fi

child_rows=$(ps -axo pid=,ppid=,command= | awk -v parent="$wrapper_pid" -v target="$real_cli" '$2 == parent && $3 == target {print $1 ":" $2}')
child_count=$(printf '%s\n' "$child_rows" | awk 'NF {count += 1} END {print count + 0}')
if [ "$child_count" -ne 1 ]; then
    printf 'expected exactly one pinned real CLI child of wrapper pid %s; found %s\n' "$wrapper_pid" "$child_count" >&2
    exit 2
fi
child_pid=$(printf '%s\n' "$child_rows" | cut -d: -f1)

wrapper_env=$(ps eww -p "$wrapper_pid" -o command= 2>/dev/null || true)
child_env=$(ps eww -p "$child_pid" -o command= 2>/dev/null || true)
case "$wrapper_env" in
    *"CODEX_CLI_PATH=$wrapper"*) ;;
    *) printf '%s\n' 'wrapper environment does not prove CODEX_CLI_PATH points to the retained wrapper' >&2; exit 2 ;;
esac
case "$wrapper_env" in
    *'CODEX_APP_SERVER_FORCE_CLI=1'*) ;;
    *) printf '%s\n' 'wrapper environment does not prove CODEX_APP_SERVER_FORCE_CLI=1' >&2; exit 2 ;;
esac
case "$wrapper_env" in
    *"LOOMHELM_STDIO_PROXY_REAL_CLI=$real_cli"*) ;;
    *) printf '%s\n' 'wrapper environment does not prove the pinned real CLI control' >&2; exit 2 ;;
esac
case "$child_env" in
    *"CODEX_CLI_PATH=$real_cli"*) ;;
    *) printf '%s\n' 'child environment does not prove CODEX_CLI_PATH points to the pinned real CLI' >&2; exit 2 ;;
esac
case "$child_env" in
    *'LOOMHELM_STDIO_PROXY_REAL_CLI='*|*'LOOMHELM_STDIO_PROXY_SOCKET='*)
        printf '%s\n' 'proxy control variables leaked into the child environment' >&2
        exit 2
        ;;
esac

printf 'verification=passed\n'
printf 'desktop_pid=%s\n' "$desktop_pid"
printf 'wrapper_pid=%s\n' "$wrapper_pid"
printf 'child_pid=%s\n' "$child_pid"
printf 'source_sha=%s\n' "$source_sha"
printf 'wrapper_sha256=%s\n' "$wrapper_sha"
printf 'real_cli_sha256=%s\n' "$real_cli_sha"
