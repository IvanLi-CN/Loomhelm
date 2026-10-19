#!/bin/sh
set -eu

mode=${1:---print}
if [ "$mode" != "--print" ] && [ "$mode" != "--apply" ]; then
    printf 'usage: %s [--print|--apply]\n' "$0" >&2
    exit 2
fi

: "${LOOMHELM_R01_WRAPPER:?set LOOMHELM_R01_WRAPPER to the reviewed wrapper binary}"
: "${LOOMHELM_R01_REAL_CLI:?set LOOMHELM_R01_REAL_CLI to the pinned bundled CLI}"
: "${LOOMHELM_R01_SOCKET:?set LOOMHELM_R01_SOCKET to a new short private socket path}"
desktop=${LOOMHELM_R01_DESKTOP_EXECUTABLE:-/Applications/ChatGPT.app/Contents/MacOS/ChatGPT}

test -f "$LOOMHELM_R01_WRAPPER"
test -f "$LOOMHELM_R01_REAL_CLI"
test -x "$LOOMHELM_R01_WRAPPER"
test -x "$LOOMHELM_R01_REAL_CLI"
test -x "$desktop"
case "$LOOMHELM_R01_SOCKET" in
    /*) ;;
    *) printf 'socket path must be absolute: %s\n' "$LOOMHELM_R01_SOCKET" >&2; exit 2 ;;
esac

printf '%s\n' 'scoped launch command:'
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
[ "$(shasum -a 256 "$LOOMHELM_R01_WRAPPER" | awk '{print $1}')" = "$LOOMHELM_R01_WRAPPER_SHA256" ]
[ "$(shasum -a 256 "$LOOMHELM_R01_REAL_CLI" | awk '{print $1}')" = "$LOOMHELM_R01_REAL_CLI_SHA256" ]

exec env \
    CODEX_CLI_PATH="$LOOMHELM_R01_WRAPPER" \
    CODEX_APP_SERVER_FORCE_CLI=1 \
    LOOMHELM_STDIO_PROXY_REAL_CLI="$LOOMHELM_R01_REAL_CLI" \
    LOOMHELM_STDIO_PROXY_SOCKET="$LOOMHELM_R01_SOCKET" \
    "$desktop"
