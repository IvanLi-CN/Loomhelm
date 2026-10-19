#!/bin/sh
set -eu

: "${LOOMHELM_R01_BASELINE_ENV_FILE:?set LOOMHELM_R01_BASELINE_ENV_FILE to a new baseline file}"
: "${LOOMHELM_R01_BASELINE_PROVENANCE:?set LOOMHELM_R01_BASELINE_PROVENANCE to the owner launcher provenance}"
baseline=$LOOMHELM_R01_BASELINE_ENV_FILE
provenance=$LOOMHELM_R01_BASELINE_PROVENANCE
case "$baseline" in
    /*) ;;
    *) printf 'baseline path must be absolute: %s\n' "$baseline" >&2; exit 2 ;;
esac
case "$provenance" in
    owner-external-terminal|owner-finder-launcher|owner-unknown) ;;
    *) printf 'baseline provenance must be owner-external-terminal, owner-finder-launcher or owner-unknown: %s\n' "$provenance" >&2; exit 2 ;;
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
    'format_version=1' \
    "provenance=$provenance" \
    "capture_pid=$$" \
    "capture_parent_pid=$PPID" \
    "CODEX_CLI_PATH=$(value_or_unset CODEX_CLI_PATH)" \
    "CODEX_APP_SERVER_FORCE_CLI=$(value_or_unset CODEX_APP_SERVER_FORCE_CLI)" \
    "LOOMHELM_STDIO_PROXY_REAL_CLI=$(value_or_unset LOOMHELM_STDIO_PROXY_REAL_CLI)" \
    "LOOMHELM_STDIO_PROXY_SOCKET=$(value_or_unset LOOMHELM_STDIO_PROXY_SOCKET)" \
    > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$baseline"
trap - EXIT HUP INT TERM

printf 'baseline_file=%s\n' "$baseline"
printf 'provenance=%s\n' "$provenance"
printf 'captured_keys=CODEX_CLI_PATH,CODEX_APP_SERVER_FORCE_CLI,LOOMHELM_STDIO_PROXY_REAL_CLI,LOOMHELM_STDIO_PROXY_SOCKET\n'
