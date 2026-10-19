#!/bin/sh
set -eu

mode=${1:---print}
if [ "$mode" != "--print" ] && [ "$mode" != "--apply" ]; then
    printf 'usage: %s [--print|--apply]\n' "$0" >&2
    exit 2
fi

: "${LOOMHELM_R01_BASELINE_ENV_FILE:?set LOOMHELM_R01_BASELINE_ENV_FILE to the captured baseline file}"
: "${LOOMHELM_R01_SOCKET:?set LOOMHELM_R01_SOCKET to the exact test socket path}"
baseline=$LOOMHELM_R01_BASELINE_ENV_FILE
test -f "$baseline"

baseline_value() {
    key=$1
    awk -F= -v wanted="$key" '$1 == wanted {sub(/^[^=]*=/, ""); print; exit}' "$baseline"
}

validate_baseline_value() {
    key=$1
    value=$2
    if [ -z "$value" ]; then
        printf 'baseline is missing %s\n' "$key" >&2
        exit 2
    fi
    case "$value" in
        __UNSET__|__EMPTY__) ;;
        *'='*|*' '*|*'	'*)
            printf 'baseline value for %s contains unsupported whitespace or equals\n' "$key" >&2
            exit 2
            ;;
    esac
}

codex_cli_path=$(baseline_value CODEX_CLI_PATH)
force_cli=$(baseline_value CODEX_APP_SERVER_FORCE_CLI)
proxy_real_cli=$(baseline_value LOOMHELM_STDIO_PROXY_REAL_CLI)
proxy_socket=$(baseline_value LOOMHELM_STDIO_PROXY_SOCKET)
validate_baseline_value CODEX_CLI_PATH "$codex_cli_path"
validate_baseline_value CODEX_APP_SERVER_FORCE_CLI "$force_cli"
validate_baseline_value LOOMHELM_STDIO_PROXY_REAL_CLI "$proxy_real_cli"
validate_baseline_value LOOMHELM_STDIO_PROXY_SOCKET "$proxy_socket"

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
printf '  baseline_file=%s\n' "$baseline"
printf '  CODEX_CLI_PATH=%s\n' "$codex_cli_path"
printf '  CODEX_APP_SERVER_FORCE_CLI=%s\n' "$force_cli"
printf '  LOOMHELM_STDIO_PROXY_REAL_CLI=%s\n' "$proxy_real_cli"
printf '  LOOMHELM_STDIO_PROXY_SOCKET=%s\n' "$proxy_socket"
printf '  executable=%s\n' "$desktop"

if [ "$mode" = "--print" ]; then
    printf '%s\n' 'dry-run only; no Desktop process was started'
    exit 0
fi

[ "${LOOMHELM_R01_OWNER_CONFIRMED:-}" = "1" ]
[ "${LOOMHELM_R01_IDLE_WINDOW_CONFIRMED:-}" = "1" ]
[ "${LOOMHELM_R01_ALLOW_RESTART:-}" = "1" ]

desktop_pids=$(ps -axo pid=,command= | awk -v target="$desktop" '$2 == target {print $1}')
[ -z "$desktop_pids" ]

if [ "$codex_cli_path" = '__UNSET__' ]; then unset CODEX_CLI_PATH; elif [ "$codex_cli_path" = '__EMPTY__' ]; then export CODEX_CLI_PATH=; else export CODEX_CLI_PATH=$codex_cli_path; fi
if [ "$force_cli" = '__UNSET__' ]; then unset CODEX_APP_SERVER_FORCE_CLI; elif [ "$force_cli" = '__EMPTY__' ]; then export CODEX_APP_SERVER_FORCE_CLI=; else export CODEX_APP_SERVER_FORCE_CLI=$force_cli; fi
if [ "$proxy_real_cli" = '__UNSET__' ]; then unset LOOMHELM_STDIO_PROXY_REAL_CLI; elif [ "$proxy_real_cli" = '__EMPTY__' ]; then export LOOMHELM_STDIO_PROXY_REAL_CLI=; else export LOOMHELM_STDIO_PROXY_REAL_CLI=$proxy_real_cli; fi
if [ "$proxy_socket" = '__UNSET__' ]; then unset LOOMHELM_STDIO_PROXY_SOCKET; elif [ "$proxy_socket" = '__EMPTY__' ]; then export LOOMHELM_STDIO_PROXY_SOCKET=; else export LOOMHELM_STDIO_PROXY_SOCKET=$proxy_socket; fi

exec "$desktop"
