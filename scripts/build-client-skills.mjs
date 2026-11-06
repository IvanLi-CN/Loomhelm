#!/usr/bin/env bun
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function walk(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist', 'tests', 'native-tests', 'fixtures', 'examples', 'references', 'assets'].includes(entry.name)) return [];
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
const nativeDigest = createHash('sha256').update(readFileSync('bin/native/posix.node')).digest('hex');
const bindNative = source => source.replace('const expectedBindingDigest: string | undefined = undefined;', `const expectedBindingDigest = "${nativeDigest}";`);
const excluded = new Set(['build.ts', 'build-service.ts', 'demo-static.ts', 'preview-source.ts', 'verify-service-native.ts', 'verify-service-browser.ts', 'diagnose-candidate-sandbox.ts']);
const entries = [...walk('bin'), ...walk('skills')].filter(path => path.endsWith('.ts') && !path.split('/').at(-1).startsWith('test_') && !excluded.has(path.split('/').at(-1)) && !readFileSync(path, 'utf8').includes('from "bun:test"'));
const transpiler = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
for (const path of entries) {
  // Keep module boundaries: relative resource roots and native bindings must not
  // silently become relative to whichever CLI happened to bundle the module.
  let source = bindNative(readFileSync(path, 'utf8'));
  source = source.replace(/((?:from\s*|import\s*\(|import\s*)["'])(\.[^"']+)(["'])/g, (match, prefix, specifier, suffix) => {
    const candidate = resolve(dirname(path), specifier);
    if (existsSync(candidate + '.ts')) return prefix + specifier + '.js' + suffix;
    if (specifier.endsWith('.ts') && existsSync(candidate)) return prefix + specifier.slice(0, -3) + '.js' + suffix;
    if (existsSync(join(candidate, 'index.ts'))) return prefix + specifier + '/index.js' + suffix;
    return match;
  });
  const prelude = 'import { fileURLToPath as __toolkitFileURLToPath } from "node:url";\nimport { dirname as __toolkitDirname, resolve as __toolkitResolve } from "node:path";\n';
  source = source.replaceAll('import.meta.dir', '__toolkitDirname(__toolkitFileURLToPath(import.meta.url))')
    .replaceAll('import.meta.path', '__toolkitFileURLToPath(import.meta.url)')
    .replaceAll('import.meta.main', '(process.argv[1] !== undefined && __toolkitResolve(process.argv[1]) === __toolkitFileURLToPath(import.meta.url))');
  writeFileSync(path.slice(0, -3) + '.js', prelude + transpiler(source));
}
// The finalizer is intentionally sealed into a single entry, unlike ordinary
// commands: plan-cli opens and validates that exact entry before evaluating it.
const sealed = await Bun.build({ entrypoints: ['bin/plan_review_view.ts'], outdir: 'bin', target: 'node', format: 'esm', packages: 'external', naming: 'plan_review_view.js', plugins: [{ name: 'sealed-native-digest', setup(build) { build.onLoad({ filter: /\/modules\/core\/posix\.ts$/ }, ({ path }) => ({ contents: bindNative(readFileSync(path, 'utf8')), loader: 'ts' })); } }] });
if (!sealed.success) { for (const log of sealed.logs) console.error(log); process.exit(1); }
console.log(JSON.stringify({ entries: entries.length, sealedFinalizer: true }));
