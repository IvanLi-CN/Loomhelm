#!/bin/bash -p
set -euo pipefail

trusted_path="/usr/bin:/bin"
PATH="$trusted_path"
export PATH

script_dir="$(cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
entrypoint="$script_dir/plan_review_view.ts"
config="$script_dir/plan_bunfig.toml"
os_name="$(/usr/bin/uname -s)"

realpath_path="/bin/realpath"
[[ -x "$realpath_path" ]] || realpath_path="/usr/bin/realpath"

file_identity() {
  if [[ "$os_name" == "Darwin" ]]; then /usr/bin/stat -f '%d:%i' -- "$1"; else /usr/bin/stat -c '%d:%i' -- "$1"; fi
}

file_links() {
  if [[ "$os_name" == "Darwin" ]]; then /usr/bin/stat -f '%l' -- "$1"; else /usr/bin/stat -c '%h' -- "$1"; fi
}

file_owner() {
  if [[ "$os_name" == "Darwin" ]]; then /usr/bin/stat -f '%u' -- "$1"; else /usr/bin/stat -c '%u' -- "$1"; fi
}

file_mode() {
  if [[ "$os_name" == "Darwin" ]]; then /usr/bin/stat -f '%Lp' -- "$1"; else /usr/bin/stat -c '%a' -- "$1"; fi
}

fd_metadata() {
  local fd="$1"
  if [[ "$os_name" == "Darwin" ]]; then
    /usr/bin/env -i /usr/bin/perl -e 'my @s = stat(STDIN) or exit 1; printf "%d:%d:%d:%d:%o\n", $s[0], $s[1], $s[3], $s[4], $s[2] & 07777' <&"$fd"
  else
    /usr/bin/stat -L -c '%d:%i:%h:%u:%a' "/proc/self/fd/$fd"
  fi
}

trusted_directory() {
  local path="$1" allow_owner_group_write="${2:-0}" owner mode current_uid current
  [[ "$path" == /* && -d "$path" && ! -L "$path" ]] || return 1
  current_uid="$(/usr/bin/id -u)"
  current="$path"
  while true; do
    [[ -d "$current" && ! -L "$current" ]] || return 1
    owner="$(file_owner "$current")"
    mode="$(file_mode "$current")"
    [[ "$owner" == "0" || "$owner" == "$current_uid" ]] || return 1
    if (( (8#$mode & 18) != 0 && (8#$mode & 512) == 0 )); then
      if [[ "$allow_owner_group_write" != "1" || "$owner" != "$current_uid" || $((8#$mode & 2)) != 0 ]]; then
        return 1
      fi
    fi
    [[ "$current" == "/" ]] && break
    current="$(/usr/bin/dirname -- "$current")"
  done
}

regular_file() {
  local path="$1" label="$2"
  if [[ ! -f "$path" || -L "$path" || "$(file_links "$path" 2>/dev/null || true)" != "1" ]]; then
    echo "ERROR: trusted Bun launcher ${label} is unavailable" >&2
    exit 2
  fi
  if [[ "$("$realpath_path" -- "$path" 2>/dev/null || true)" != "$path" ]]; then
    echo "ERROR: trusted Bun launcher ${label} path changed" >&2
    exit 2
  fi
}

trusted_file() {
  local path="$1" label="$2" owner mode current_uid
  regular_file "$path" "$label"
  owner="$(file_owner "$path")"
  mode="$(file_mode "$path")"
  current_uid="$(/usr/bin/id -u)"
  if [[ "$owner" != "0" && "$owner" != "$current_uid" ]] || (( (8#$mode & 18) != 0 )); then
    echo "ERROR: trusted Bun launcher ${label} is not trusted" >&2
    exit 2
  fi
}

trusted_file "$entrypoint" "entrypoint"
trusted_file "$config" "configuration"
trusted_directory "$script_dir" || { echo "ERROR: trusted dev-plan directory is not trusted" >&2; exit 2; }

runtime=""
if [[ "$os_name" == "Darwin" ]]; then
  user_home="$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -un)" NFSHomeDirectory 2>/dev/null | /usr/bin/awk '{print $2}' || true)"
else
  user_home="$(/usr/bin/getent passwd "$(/usr/bin/id -u)" 2>/dev/null | /usr/bin/awk -F: '{print $6}' || true)"
fi
runtime_candidates=()
if [[ "$user_home" == /* && "$user_home" != *$'\n'* ]]; then runtime_candidates+=("$user_home/.bun/bin/bun"); fi
runtime_candidates+=(
  /usr/local/lib/loomhelm/runtime/bun
  /opt/homebrew/bin/bun
  /usr/local/bin/bun
  /usr/bin/bun
  /bin/bun
  /home/linuxbrew/.linuxbrew/bin/bun
  /root/.bun/bin/bun
)
for candidate in "${runtime_candidates[@]}"; do
  if [[ -f "$candidate" && -x "$candidate" ]]; then
    runtime="$("$realpath_path" -- "$candidate" 2>/dev/null || true)"
    [[ -n "$runtime" ]] && break
  fi
done
if [[ -z "$runtime" ]]; then
  echo "ERROR: repository-approved Bun runtime is unavailable" >&2
  exit 2
fi
regular_file "$runtime" "runtime"
trusted_directory "$(/usr/bin/dirname -- "$runtime")" 1 || { echo "ERROR: repository-approved Bun runtime directory is not trusted" >&2; exit 2; }
runtime_owner="$(file_owner "$runtime")"
runtime_mode="$(file_mode "$runtime")"
current_uid="$(/usr/bin/id -u)"
if [[ "$runtime_owner" != "0" && "$runtime_owner" != "$current_uid" ]] || (( (8#$runtime_mode & 18) != 0 )); then
  echo "ERROR: repository-approved Bun runtime is not trusted" >&2
  exit 2
fi
if [[ -n "${BUN_BIN:-}" ]]; then
  requested_runtime="$("$realpath_path" -- "$BUN_BIN" 2>/dev/null || true)"
  if [[ -z "$requested_runtime" || "$requested_runtime" != "$runtime" ]]; then
    echo "ERROR: BUN_BIN must name the repository-approved Bun runtime" >&2
    exit 2
  fi
fi

runtime_identity="$(file_identity "$runtime")"
entrypoint_identity="$(file_identity "$entrypoint")"
config_identity="$(file_identity "$config")"
entrypoint_owner="$(file_owner "$entrypoint")"
entrypoint_mode="$(file_mode "$entrypoint")"
config_owner="$(file_owner "$config")"
config_mode="$(file_mode "$config")"
exec 7<"$runtime"
if [[ "$(fd_metadata 7 2>/dev/null || true)" != "$runtime_identity:1:$runtime_owner:$runtime_mode" ]]; then
  echo "ERROR: repository-approved Bun runtime changed while opening" >&2
  exit 2
fi
exec 8<"$config"
if [[ "$(fd_metadata 8 2>/dev/null || true)" != "$config_identity:1:$config_owner:$config_mode" ]]; then
  echo "ERROR: trusted Bun launcher configuration changed while opening" >&2
  exit 2
fi
exec 9<"$entrypoint"
if [[ "$(fd_metadata 9 2>/dev/null || true)" != "$entrypoint_identity:1:$entrypoint_owner:$entrypoint_mode" ]]; then
  echo "ERROR: trusted Bun launcher entrypoint changed while opening" >&2
  exit 2
fi

temporary_root="${TMPDIR:-/tmp}"
[[ "$temporary_root" == /* ]] || { echo "ERROR: Bun launcher temporary directory must be absolute" >&2; exit 2; }
temporary_root="$("$realpath_path" -- "$temporary_root" 2>/dev/null || true)"
[[ -n "$temporary_root" ]] || { echo "ERROR: Bun launcher temporary directory cannot be canonicalized" >&2; exit 2; }
trusted_directory "$temporary_root" || { echo "ERROR: Bun launcher temporary directory is not trusted" >&2; exit 2; }
temporary_dir="$(/usr/bin/mktemp -d "$temporary_root/dev-plan-launcher.XXXXXX")" || { echo "ERROR: unable to create secure Bun launcher directory" >&2; exit 2; }
/bin/chmod 700 "$temporary_dir"
config_copy="$temporary_dir/plan_bunfig.toml"
cleanup_staged() {
  /bin/rm -f -- "$config_copy" "${runtime_copy:-}" 2>/dev/null || true
  /bin/rmdir -- "$temporary_dir" 2>/dev/null || true
}
trap cleanup_staged EXIT
trap 'cleanup_staged; exit 130' INT
trap 'cleanup_staged; exit 143' TERM HUP
set -C
/bin/cat <&8 >"$config_copy"
set +C
exec 8<&-
/bin/chmod 600 "$config_copy"
runtime_copy="$temporary_dir/bun"
set -C
/bin/cat <&7 >"$runtime_copy"
set +C
/bin/chmod 700 "$runtime_copy"

runtime_version="$(/usr/bin/env -u BUN_INSPECT_PRELOAD -u BUN_OPTIONS -u NODE_OPTIONS -u BUN_CONFIG -u BUN_CONFIG_PATH -u BUN_BIN "$runtime_copy" --version 2>/dev/null || true)"
if [[ "$runtime_version" != 1.4.4 ]]; then
  echo "ERROR: Bun 1.4.4 is required; found ${runtime_version:-unavailable}" >&2
  exit 2
fi

launcher_code='
const fs = require("node:fs");
const entrypointFd = Number(process.env.PLAN_REVIEW_ENTRYPOINT_FD);
const expected = process.env.PLAN_REVIEW_ENTRYPOINT_IDENTITY;
const configCopy = process.env.PLAN_REVIEW_CONFIG_COPY;
const runtimeCopy = process.env.PLAN_REVIEW_RUNTIME_COPY;
const temporaryDir = process.env.PLAN_REVIEW_TEMPORARY_DIR;
const cleanup = () => {
  if (configCopy) { try { fs.unlinkSync(configCopy); } catch {} }
  if (runtimeCopy) { try { fs.unlinkSync(runtimeCopy); } catch {} }
  if (temporaryDir) { try { fs.rmdirSync(temporaryDir); } catch {} }
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.once(signal, () => { cleanup(); process.kill(process.pid, signal); });
cleanup();
if (!Number.isInteger(entrypointFd) || !expected) throw new Error("trusted plan entrypoint binding is unavailable");
const fd = entrypointFd;
try {
  const before = fs.fstatSync(fd);
  if (!before.isFile() || before.nlink !== 1 || `${before.dev}:${before.ino}` !== expected) throw new Error("trusted plan entrypoint identity changed");
  const source = fs.readFileSync(fd);
  const after = fs.fstatSync(fd);
  if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino) throw new Error("trusted plan entrypoint changed while reading");
  process.argv = [process.argv[0], "plan_review_view.ts", ...process.argv.slice(1)];
  await import(`data:text/typescript;base64,${source.toString("base64")}`);
}
finally { fs.closeSync(fd); }
'

exec /usr/bin/env -u BUN_INSPECT_PRELOAD -u BUN_OPTIONS -u NODE_OPTIONS -u BUN_CONFIG -u BUN_CONFIG_PATH -u BUN_BIN \
  PATH="$trusted_path" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
  PLAN_REVIEW_ENTRYPOINT_FD=9 \
  PLAN_REVIEW_ENTRYPOINT_PATH="$entrypoint" \
  PLAN_REVIEW_ENTRYPOINT_IDENTITY="$entrypoint_identity" \
  PLAN_REVIEW_CONFIG_COPY="$config_copy" \
  PLAN_REVIEW_RUNTIME_COPY="$runtime_copy" \
  PLAN_REVIEW_TEMPORARY_DIR="$temporary_dir" \
  "$runtime_copy" \
  --config="$config_copy" \
  --no-install \
  --no-env-file \
  --no-macros \
  --tsconfig-override=/dev/null \
  -e "$launcher_code" -- "$@"
