#!/bin/sh
set -eu

mode=${1:---print}
if [ "$mode" != "--print" ] && [ "$mode" != "--apply" ]; then
    printf 'usage: %s [--print|--apply]\n' "$0" >&2
    exit 2
fi

: "${LOOMHELM_R01_STAGE_MANIFEST:?set LOOMHELM_R01_STAGE_MANIFEST to the retained candidate manifest}"
manifest=$LOOMHELM_R01_STAGE_MANIFEST
test -f "$manifest"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../../../.." && pwd)
manifest_value() {
    key=$1
    awk -F= -v wanted="$key" '$1 == wanted {sub(/^[^=]*=/, ""); print; exit}' "$manifest"
}

source_sha=$(manifest_value source_sha)
manifest_wrapper=$(manifest_value wrapper_path)
manifest_wrapper_sha=$(manifest_value wrapper_sha256)
manifest_real_cli=$(manifest_value real_cli_path)
manifest_real_cli_sha=$(manifest_value real_cli_sha256)
test -n "$source_sha"
test -n "$manifest_wrapper"
test -n "$manifest_wrapper_sha"
test -n "$manifest_real_cli"
test -n "$manifest_real_cli_sha"
if [ -n "$(git -C "$repo_dir" status --porcelain --untracked-files=all)" ]; then
    printf '%s\n' 'refusing to launch a candidate while the repository is dirty' >&2
    exit 2
fi

: "${LOOMHELM_R01_BASELINE_ENV_FILE:?set LOOMHELM_R01_BASELINE_ENV_FILE to the captured baseline file}"
: "${LOOMHELM_R01_WRAPPER:=$manifest_wrapper}"
: "${LOOMHELM_R01_REAL_CLI:=$manifest_real_cli}"
: "${LOOMHELM_R01_SOCKET:?set LOOMHELM_R01_SOCKET to a new short private socket path}"
desktop=${LOOMHELM_R01_DESKTOP_EXECUTABLE:-/Applications/ChatGPT.app/Contents/MacOS/ChatGPT}

[ "$LOOMHELM_R01_WRAPPER" = "$manifest_wrapper" ]
[ "$LOOMHELM_R01_REAL_CLI" = "$manifest_real_cli" ]
test -f "$LOOMHELM_R01_BASELINE_ENV_FILE"
baseline_format=$(awk -F= '$1 == "format_version" {sub(/^[^=]*=/, ""); print; exit}' "$LOOMHELM_R01_BASELINE_ENV_FILE")
[ "$baseline_format" = 1 ] || { printf 'baseline format is missing or unsupported: %s\n' "$baseline_format" >&2; exit 2; }
baseline_provenance=$(awk -F= '$1 == "provenance" {sub(/^[^=]*=/, ""); print; exit}' "$LOOMHELM_R01_BASELINE_ENV_FILE")
case "$baseline_provenance" in
    owner-external-terminal|owner-finder-launcher|owner-unknown) ;;
    *) printf 'baseline provenance is missing or unsupported: %s\n' "$baseline_provenance" >&2; exit 2 ;;
esac
test -f "$LOOMHELM_R01_WRAPPER"
test -f "$LOOMHELM_R01_REAL_CLI"
test -x "$LOOMHELM_R01_WRAPPER"
test -x "$LOOMHELM_R01_REAL_CLI"
test -x "$desktop"
case "$LOOMHELM_R01_SOCKET" in
    /*) ;;
    *) printf 'socket path must be absolute: %s\n' "$LOOMHELM_R01_SOCKET" >&2; exit 2 ;;
esac
[ "${#LOOMHELM_R01_SOCKET}" -le 90 ]
socket_dir=$(dirname -- "$LOOMHELM_R01_SOCKET")
test -d "$socket_dir"
[ "$(stat -f '%Lp' "$socket_dir")" = 700 ]
[ ! -e "$LOOMHELM_R01_SOCKET" ]

desktop_pids=$(ps -axo pid=,command= | awk -v target="$desktop" '$2 == target {print $1}')

printf '%s\n' 'scoped launch command:'
printf '  candidate_source_sha=%s\n' "$source_sha"
printf '  retained_wrapper=%s\n' "$LOOMHELM_R01_WRAPPER"
printf '  retained_wrapper_sha256=%s\n' "$manifest_wrapper_sha"
printf '  pinned_real_cli=%s\n' "$LOOMHELM_R01_REAL_CLI"
printf '  pinned_real_cli_sha256=%s\n' "$manifest_real_cli_sha"
printf '  baseline_provenance=%s\n' "$baseline_provenance"
printf '  socket=%s (parent_mode=%s)\n' "$LOOMHELM_R01_SOCKET" "$(stat -f '%Lp' "$socket_dir")"
if [ -n "$desktop_pids" ]; then
    printf '  desktop_existing_pids=%s\n' "$desktop_pids"
else
    printf '%s\n' '  desktop_existing_pids=<none>'
fi
printf '  env CODEX_CLI_PATH=%s CODEX_APP_SERVER_FORCE_CLI=1 ' "$LOOMHELM_R01_WRAPPER"
printf 'LOOMHELM_STDIO_PROXY_REAL_CLI=%s LOOMHELM_STDIO_PROXY_SOCKET=%s ' "$LOOMHELM_R01_REAL_CLI" "$LOOMHELM_R01_SOCKET"
printf '%s\n' "$desktop"

if [ "$mode" = "--print" ]; then
    printf '%s\n' 'dry-run only; no Desktop process was started'
    exit 0
fi

[ "${LOOMHELM_R01_OWNER_CONFIRMED:-}" = "1" ]
[ "${LOOMHELM_R01_IDLE_WINDOW_CONFIRMED:-}" = "1" ]
[ "${LOOMHELM_R01_ALLOW_RESTART:-}" = "1" ]
: "${LOOMHELM_R01_WRAPPER_SHA256:?set the reviewed wrapper SHA256 before --apply}"
: "${LOOMHELM_R01_REAL_CLI_SHA256:?set the pinned real CLI SHA256 before --apply}"
[ "$LOOMHELM_R01_WRAPPER_SHA256" = "$manifest_wrapper_sha" ]
[ "$LOOMHELM_R01_REAL_CLI_SHA256" = "$manifest_real_cli_sha" ]
[ -z "$desktop_pids" ]
[ "$(shasum -a 256 "$LOOMHELM_R01_WRAPPER" | awk '{print $1}')" = "$LOOMHELM_R01_WRAPPER_SHA256" ]
[ "$(shasum -a 256 "$LOOMHELM_R01_REAL_CLI" | awk '{print $1}')" = "$LOOMHELM_R01_REAL_CLI_SHA256" ]

exec env \
    CODEX_CLI_PATH="$LOOMHELM_R01_WRAPPER" \
    CODEX_APP_SERVER_FORCE_CLI=1 \
    LOOMHELM_STDIO_PROXY_REAL_CLI="$LOOMHELM_R01_REAL_CLI" \
    LOOMHELM_STDIO_PROXY_SOCKET="$LOOMHELM_R01_SOCKET" \
    "$desktop"
