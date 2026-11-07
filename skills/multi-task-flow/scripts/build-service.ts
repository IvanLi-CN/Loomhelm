import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { compatibility } from "./service-contract";
import { buildId, digest, verifyRelease } from "./service-release";
import { requireCondition } from "./errors";
import { copySkillSources } from "../../scripts/package-source.mjs";

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const output = args.includes("--output") ? resolve(option("--output")!) : null;
const version = args.includes("--service-version") ? option("--service-version") : null;
requireCondition(output && version && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version), "INVALID_ARGUMENTS", "build-service.ts --output <new-directory> --service-version <semver>");
requireCondition(!existsSync(output), "OUTPUT_EXISTS", "Build output must be a new directory");
requireCondition(Bun.version === "1.4.4", "RUNTIME_REQUIRED", "Bun 1.4.4 is required");
const root = resolve(import.meta.dir, "../../..");
const source = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
requireCondition(source.exitCode === 0, "SOURCE_IDENTITY_REQUIRED", "Build requires a source commit");
const clean = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root });
requireCondition(clean.exitCode === 0 && !clean.stdout.toString().trim(), "DIRTY_SOURCE", "Release builds require committed clean source");
const executable = realpathSync(process.execPath);
const runtime = lstatSync(executable);
requireCondition(runtime.isFile() && runtime.nlink === 1 && (runtime.mode & 0o022) === 0 && (runtime.uid === 0 || runtime.uid === process.getuid?.()), "RUNTIME_UNTRUSTED", "Bun runtime must be a trusted regular file");
mkdirSync(output, { recursive: true, mode: 0o700 });
const files: Record<string,string> = copySkillSources(root, output, { dependencies: true });
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const runtimeSha = digest(readFileSync(executable));
const launcher = `#!/bin/bash -p
set -euo pipefail
PATH=/usr/bin:/bin
export PATH
viewer_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
runtime=${quote(executable)}
os=$(uname -s)
metadata() {
  if [[ "$os" == Darwin ]]; then stat -f '%d:%i:%l:%u:%Lp' -- "$1"; else stat -c '%d:%i:%h:%u:%a' -- "$1"; fi
}
trusted() {
  local path="$1" uid mode
  [[ -e "$path" && ! -L "$path" ]] || return 1
  if [[ "$os" == Darwin ]]; then uid=$(stat -f '%u' -- "$path"); mode=$(stat -f '%Lp' -- "$path"); else uid=$(stat -c '%u' -- "$path"); mode=$(stat -c '%a' -- "$path"); fi
  [[ "$uid" == 0 || "$uid" == "$(id -u)" ]] && (( (8#$mode & 18) == 0 || ($uid == 0 && (8#$mode & 512) != 0) ))
}
# Validate the pinned executable and every ancestor before opening its descriptor.
[[ -f "$runtime" && -x "$runtime" ]] && trusted "$runtime" || { echo BUN_RUNTIME_UNTRUSTED >&2; exit 2; }
path=$(dirname -- "$runtime")
while true; do trusted "$path" || { echo BUN_RUNTIME_ANCESTOR_UNTRUSTED >&2; exit 2; }; [[ "$path" == / ]] && break; path=$(dirname -- "$path"); done
identity=$(metadata "$runtime")
exec 7<"$runtime"
if [[ "$os" == Darwin ]]; then opened=$(env -i /usr/bin/perl -e 'my @s=stat(STDIN) or exit 1; printf "%d:%d:%d:%d:%o",$s[0],$s[1],$s[3],$s[4],$s[2]&07777' <&7); else opened=$(stat -L -c '%d:%i:%h:%u:%a' /proc/self/fd/7); fi
[[ "$opened" == "$identity" ]] || { echo BUN_RUNTIME_CHANGED >&2; exit 2; }
# A private executable snapshot avoids re-opening the checked runtime path.
temporary=$(mktemp -d "${TMPDIR:-/tmp}/loomhelm-viewer.XXXXXX")
chmod 700 "$temporary"
cleanup() { rm -f -- "$temporary/bun"; rmdir -- "$temporary"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
(set -C; cat <&7 > "$temporary/bun")
exec 7<&-
chmod 700 "$temporary/bun"
actual=$(shasum -a 256 "$temporary/bun")
[[ "${actual%% *}" == ${quote(runtimeSha)} ]] || { echo BUN_RUNTIME_CHANGED >&2; exit 2; }
version=$(env -u BUN_OPTIONS -u BUN_INSPECT_PRELOAD -u NODE_OPTIONS -u BUN_CONFIG -u BUN_CONFIG_PATH "$temporary/bun" --version)
[[ "$version" == 1.4.4 ]] || { echo BUN_RUNTIME_REQUIRED >&2; exit 2; }
exec env -u BUN_OPTIONS -u BUN_INSPECT_PRELOAD -u NODE_OPTIONS -u BUN_CONFIG -u BUN_CONFIG_PATH LOOMHELM_VIEWER_RUNTIME_TEMP="$temporary" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$temporary/bun" --preload='data:text/javascript,import{unlinkSync,rmdirSync}from"node:fs";const p=process.env.LOOMHELM_VIEWER_RUNTIME_TEMP;delete process.env.LOOMHELM_VIEWER_RUNTIME_TEMP;unlinkSync(p+"/bun");rmdirSync(p);' --config="$viewer_dir/skills/bin/plan_bunfig.toml" --no-install --no-env-file --no-macros --tsconfig-override=/dev/null "$viewer_dir/skills/multi-task-flow/scripts/service.ts" "$@"
`;

writeFileSync(join(output,"viewer"), launcher, { mode: 0o700 });
files.viewer = digest(launcher);
const manifest = { schema_version: 2 as const, source_sha: source.stdout.toString().trim(), service_version: version, platform: `${process.platform}-${process.arch}` as "darwin-arm64", api_versions: compatibility.api_versions, frontend_contracts: compatibility.frontend_contracts, readable: compatibility.readable, writable: compatibility.writable, files };
writeFileSync(join(output,"manifest.json"), JSON.stringify({ ...manifest, build_id: buildId(manifest) },null,2)+'\n', {mode:0o600});
const verified = verifyRelease(output);
console.log(JSON.stringify({ok:true, build_id:verified.build_id, output, runtime:'bun@1.4.4'}));
