#!/bin/sh
set -eu

mode=${1:---print}
if [ "$mode" != "--print" ] && [ "$mode" != "--apply" ]; then
    printf 'usage: %s [--print|--apply]\n' "$0" >&2
    exit 2
fi

: "${LOOMHELM_R01_SOCKET:?set LOOMHELM_R01_SOCKET to the exact test socket path}"
desktop=${LOOMHELM_R01_DESKTOP_EXECUTABLE:-/Applications/ChatGPT.app/Contents/MacOS/ChatGPT}
test -x "$desktop"
case "$LOOMHELM_R01_SOCKET" in
    /*) ;;
    *) printf 'socket path must be absolute: %s\n' "$LOOMHELM_R01_SOCKET" >&2; exit 2 ;;
esac

if [ -e "$LOOMHELM_R01_SOCKET" ]; then
    printf 'refusing rollback while the exact test socket exists: %s\n' "$LOOMHELM_R01_SOCKET" >&2
    exit 2
fi

printf '%s\n' 'scoped rollback command:'
printf '  env -u CODEX_CLI_PATH -u CODEX_APP_SERVER_FORCE_CLI '
printf '%s\n' '-u LOOMHELM_STDIO_PROXY_REAL_CLI -u LOOMHELM_STDIO_PROXY_SOCKET' "$desktop"

if [ "$mode" = "--print" ]; then
    printf '%s\n' 'dry-run only; no Desktop process was started'
    exit 0
fi

[ "${LOOMHELM_R01_OWNER_CONFIRMED:-}" = "1" ]
[ "${LOOMHELM_R01_IDLE_WINDOW_CONFIRMED:-}" = "1" ]
[ "${LOOMHELM_R01_ALLOW_RESTART:-}" = "1" ]

exec env \
    -u CODEX_CLI_PATH \
    -u CODEX_APP_SERVER_FORCE_CLI \
    -u LOOMHELM_STDIO_PROXY_REAL_CLI \
    -u LOOMHELM_STDIO_PROXY_SOCKET \
    "$desktop"
