// Regenerate the dependency closure of the supported official Codex protocol.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'loomhelm-codex-schema-'));
try {
  const version = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) throw new Error('Cannot read Codex version');
  const generated = spawnSync('codex', ['app-server', 'generate-ts', '--out', root], { encoding: 'utf8' });
  if (generated.status !== 0) throw new Error(generated.stderr);
  const names = ['InitializeParams', 'InitializeResponse', 'ServerRequest',
    ...['ThreadStart', 'ThreadResume', 'ThreadFork', 'ThreadRead', 'ThreadList', 'ThreadTurnsList', 'TurnStart', 'TurnInterrupt', 'ModelList'].flatMap(name => [`v2/${name}Params`, `v2/${name}Response`]),
    'v2/ThreadSetNameParams', 'v2/CommandExecutionRequestApprovalResponse', 'v2/FileChangeRequestApprovalResponse'];
  const sources = new Map();
  function visit(path) {
    if (sources.has(path)) return;
    const source = readFileSync(path, 'utf8');
    sources.set(path, source);
    for (const match of source.matchAll(/^import type .* from "(.+)";$/gm)) visit(resolve(dirname(path), `${match[1]}.ts`));
  }
  for (const name of names) visit(join(root, `${name}.ts`));
  const body = [...sources].sort(([a], [b]) => a.localeCompare(b)).map(([path, source]) =>
    `// Source: ${path.slice(root.length + 1)}\n` + source.replace(/^\/\/.*\n/gm, '').replace(/^import type .*\n/gm, '').trim()).join('\n\n');
  writeFileSync(new URL('./protocol.ts', import.meta.url), `// Generated from ${version.stdout.trim()} app-server generate-ts (stable).\n// Run: bun src/codex/generate-protocol.mjs\n// Upstream: https://github.com/openai/codex (Apache-2.0).\n// Bundled dependency closure; only import declarations and generator headers removed.\n\n${body}\n`);
} finally { rmSync(root, { recursive: true, force: true }); }
