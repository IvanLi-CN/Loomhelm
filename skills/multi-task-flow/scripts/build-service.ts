import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { compatibility } from "./service-contract";
import { buildId, digest, verifyRelease } from "./service-release";
import { requireCondition } from "./errors";
import { copySkillSources } from "../../scripts/package-source.ts";

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
const manifest = { schema_version: 2 as const, source_sha: source.stdout.toString().trim(), service_version: version, platform: `${process.platform}-${process.arch}` as "darwin-arm64", api_versions: compatibility.api_versions, frontend_contracts: compatibility.frontend_contracts, readable: compatibility.readable, writable: compatibility.writable, files };
// Bind resource metadata before adding the launcher itself, avoiding a self-hash cycle.
const resourceIdentity = buildId(manifest);
const bootstrap = `import * as fs from "node:fs";import * as path from "node:path";import{createHash}from"node:crypto";
const hash=v=>createHash("sha256").update(v).digest("hex");
const root=process.env.LOOMHELM_VIEWER_RELEASE,temporary=process.env.LOOMHELM_VIEWER_RUNTIME_TEMP;
delete process.env.LOOMHELM_VIEWER_RELEASE;delete process.env.LOOMHELM_VIEWER_RUNTIME_TEMP;
try {
const trusted=(p,stickyAncestor=false)=>{const s=fs.lstatSync(p);if(s.isSymbolicLink()||(s.uid!==0&&s.uid!==process.getuid())||((s.mode&0o022)!==0&&!(stickyAncestor&&s.isDirectory()&&s.uid===0&&(s.mode&0o1000)!==0)))throw Error("VIEWER_RESOURCE_UNTRUSTED");return s;};
for(let p=root;;p=path.dirname(p)){if(!trusted(p,p!==root).isDirectory())throw Error("VIEWER_DIRECTORY_UNTRUSTED");if(p===path.dirname(p))break;}
const read=p=>{const s=trusted(p);if(!s.isFile()||s.nlink!==1)throw Error("VIEWER_RESOURCE_UNTRUSTED");const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const a=fs.fstatSync(fd);if(a.dev!==s.dev||a.ino!==s.ino)throw Error("VIEWER_RESOURCE_CHANGED");return fs.readFileSync(fd);}finally{fs.closeSync(fd);}};
const m=JSON.parse(read(path.join(root,"manifest.json"))),{build_id,...body}=m;
const launcherHash=body.files.viewer;delete body.files.viewer;
body.files=Object.fromEntries(Object.entries(body.files).sort(([a],[b])=>a.localeCompare(b)));
if(hash(JSON.stringify(body))!==${JSON.stringify(resourceIdentity)})throw Error("VIEWER_RESOURCE_IDENTITY_MISMATCH");
body.files.viewer=launcherHash;
// Reject additional files before Bun can resolve an extensionless import to them.
const listed=new Set([...Object.keys(body.files),"manifest.json"]);
const walk=directory=>{for(const name of fs.readdirSync(directory)){const p=path.join(directory,name),s=trusted(p);if(s.isDirectory())walk(p);else if(!s.isFile()||s.nlink!==1||!listed.has(path.relative(root,p).split(path.sep).join("/")))throw Error("VIEWER_RESOURCE_UNLISTED");}};
walk(root);
for(const [name,expected]of Object.entries(body.files)){
if(name.includes("\\\\")||name.split("/").some(p=>!p||p==="."||p==="..")||(name!=="viewer"&&!name.startsWith("skills/")))throw Error("VIEWER_RESOURCE_PATH");
const p=path.join(root,name);if(fs.realpathSync(p)!==p)throw Error("VIEWER_RESOURCE_PATH");
for(let d=path.dirname(p);d!==root;d=path.dirname(d))if(!trusted(d).isDirectory())throw Error("VIEWER_DIRECTORY_UNTRUSTED");
if(hash(read(p))!==expected)throw Error("VIEWER_RESOURCE_CHECKSUM");
}
} finally {fs.unlinkSync(path.join(temporary,"bun"));fs.unlinkSync(path.join(temporary,"bunfig.toml"));fs.rmdirSync(temporary);}
`;
const bootstrapUrl = "data:text/javascript;base64," + Buffer.from(bootstrap).toString("base64");
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
  local path="$1" allow_group="\${2:-0}" uid mode sticky_directory=0
  [[ -e "$path" && ! -L "$path" ]] || return 1
  if [[ "$os" == Darwin ]]; then uid=$(stat -f '%u' -- "$path"); mode=$(stat -f '%Lp' -- "$path"); else uid=$(stat -c '%u' -- "$path"); mode=$(stat -c '%a' -- "$path"); fi
  [[ -d "$path" ]] && sticky_directory=1
  [[ "$uid" == 0 || "$uid" == "$(id -u)" ]] && (( (8#$mode & 18) == 0 || ($uid == 0 && $sticky_directory == 1 && (8#$mode & 512) != 0) || ($allow_group == 1 && $uid == $(id -u) && (8#$mode & 2) == 0) ))
}
# Validate the pinned executable and every ancestor before opening its descriptor.
[[ -f "$runtime" && -x "$runtime" ]] && trusted "$runtime" || { echo BUN_RUNTIME_UNTRUSTED >&2; exit 2; }
path=$(dirname -- "$runtime")
while true; do trusted "$path" 1 || { echo BUN_RUNTIME_ANCESTOR_UNTRUSTED >&2; exit 2; }; [[ "$path" == / ]] && break; path=$(dirname -- "$path"); done
identity=$(metadata "$runtime")
exec 7<"$runtime"
if [[ "$os" == Darwin ]]; then opened=$(env -i /usr/bin/perl -e 'my @s=stat(STDIN) or exit 1; printf "%d:%d:%d:%d:%o",$s[0],$s[1],$s[3],$s[4],$s[2]&07777' <&7); else opened=$(stat -L -c '%d:%i:%h:%u:%a' /proc/self/fd/7); fi
[[ "$opened" == "$identity" ]] || { echo BUN_RUNTIME_CHANGED >&2; exit 2; }
# A private executable snapshot avoids re-opening the checked runtime path.
temporary_root=$(CDPATH= cd -- "\${TMPDIR:-/tmp}" && pwd -P) || { echo VIEWER_TEMP_UNTRUSTED >&2; exit 2; }
path="$temporary_root"
while true; do [[ -d "$path" ]] && trusted "$path" || { echo VIEWER_TEMP_UNTRUSTED >&2; exit 2; }; [[ "$path" == / ]] && break; path=$(dirname -- "$path"); done
temporary=$(mktemp -d "$temporary_root/loomhelm-viewer.XXXXXX")
chmod 700 "$temporary"
cleanup() { rm -f -- "$temporary/bun" "$temporary/bunfig.toml"; rmdir -- "$temporary"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
(set -C; cat <&7 > "$temporary/bun")
exec 7<&-
chmod 700 "$temporary/bun"
actual=$(shasum -a 256 "$temporary/bun")
[[ "\${actual%% *}" == ${quote(runtimeSha)} ]] || { echo BUN_RUNTIME_CHANGED >&2; exit 2; }
version=$(env -u BUN_OPTIONS -u BUN_INSPECT_PRELOAD -u NODE_OPTIONS -u BUN_CONFIG -u BUN_CONFIG_PATH "$temporary/bun" --version)
[[ "$version" == 1.4.4 ]] || { echo BUN_RUNTIME_REQUIRED >&2; exit 2; }
# Never load executable configuration from the unverified release.
printf '%s\\n' '# Private controlled configuration: no preloads or hooks.' > "$temporary/bunfig.toml"
exec env -u BUN_OPTIONS -u BUN_INSPECT_PRELOAD -u NODE_OPTIONS -u BUN_CONFIG -u BUN_CONFIG_PATH LOOMHELM_VIEWER_RELEASE="$viewer_dir" LOOMHELM_VIEWER_RUNTIME_TEMP="$temporary" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$temporary/bun" --preload=${quote(bootstrapUrl)} --config="$temporary/bunfig.toml" --no-install --no-env-file --no-macros --tsconfig-override=/dev/null "$viewer_dir/skills/multi-task-flow/scripts/service.ts" "$@"
`;

writeFileSync(join(output,"viewer"), launcher, { mode: 0o700 });
files.viewer = digest(launcher);
writeFileSync(join(output,"manifest.json"), JSON.stringify({ ...manifest, build_id: buildId(manifest) },null,2)+'\n', {mode:0o600});
const verified = verifyRelease(output);
console.log(JSON.stringify({ok:true, build_id:verified.build_id, output, runtime:'bun@1.4.4'}));
