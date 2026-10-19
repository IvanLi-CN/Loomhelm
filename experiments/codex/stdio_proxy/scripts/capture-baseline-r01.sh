#!/bin/sh
set -eu

: "${LOOMHELM_R01_BASELINE_ENV_FILE:?set LOOMHELM_R01_BASELINE_ENV_FILE to a new baseline file}"
baseline=$LOOMHELM_R01_BASELINE_ENV_FILE
case "$baseline" in
    /*) ;;
    *) printf 'baseline path must be absolute: %s\n' "$baseline" >&2; exit 2 ;;
esac
if [ -e "$baseline" ]; then
    printf 'baseline file already exists; choose a new path: %s\n' "$baseline" >&2
    exit 2
fi
parent=$(dirname -- "$baseline")
test -d "$parent"

umask 077
tmp=$(mktemp "$parent/.loomhelm-r01-baseline.XXXXXX")
cleanup() {
    rm -f "$tmp"
}
trap cleanup EXIT HUP INT TERM

value_or_unset() {
    key=$1
    if printenv "$key" >/dev/null 2>&1; then
        value=$(printenv "$key")
        if [ -n "$value" ]; then
            printf '%s' "$value"
        else
            printf '%s' '__EMPTY__'
        fi
    else
        printf '%s' '__UNSET__'
    fi
}

printf '%s\n' \
    "CODEX_CLI_PATH=$(value_or_unset CODEX_CLI_PATH)" \
    "CODEX_APP_SERVER_FORCE_CLI=$(value_or_unset CODEX_APP_SERVER_FORCE_CLI)" \
    "LOOMHELM_STDIO_PROXY_REAL_CLI=$(value_or_unset LOOMHELM_STDIO_PROXY_REAL_CLI)" \
    "LOOMHELM_STDIO_PROXY_SOCKET=$(value_or_unset LOOMHELM_STDIO_PROXY_SOCKET)" \
    > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$baseline"
trap - EXIT HUP INT TERM

printf 'baseline_file=%s\n' "$baseline"
printf 'captured_keys=CODEX_CLI_PATH,CODEX_APP_SERVER_FORCE_CLI,LOOMHELM_STDIO_PROXY_REAL_CLI,LOOMHELM_STDIO_PROXY_SOCKET\n'
