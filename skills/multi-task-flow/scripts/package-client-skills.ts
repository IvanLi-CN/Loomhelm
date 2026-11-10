#!/usr/bin/env -S bun --no-install
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
const root = resolve(import.meta.dirname, '../../..');
const target = resolve(root, 'clients/typescript/toolkit');
const manifest = JSON.parse(readFileSync(resolve(root, 'skills/source-manifest.json'), 'utf8'));
const packageMetadata = JSON.parse(readFileSync(resolve(root, 'clients/typescript/package.json'), 'utf8'));
const packageConfig = packageMetadata.loomhelm;
const requireDependencies = process.argv.includes('--require-dependencies');
const productPartitionBuild = Boolean(process.env.LOOMHELM_PRODUCT_BUILD_VERSION?.trim());
const exactSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const sha1 = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;
const packageOmissions = [{ path: 'skills/multi-task-flow/.gitignore', reason: 'package-root .gitignore is omitted by npm-compatible package archives' }];
const packageOmissionPaths = new Set(packageOmissions.map(item => item.path));
if (packageMetadata.name !== '@loomhelm/multi-task-flow' || typeof packageMetadata.version !== 'string' || !exactSemver.test(packageMetadata.version) || packageMetadata.version.split('-')[1]?.split('.').some(part => /^0\d+$/.test(part)) || !packageConfig || packageConfig.compatibilityLine !== 'compat-v1' || typeof packageConfig.skillVersion !== 'string' || !exactSemver.test(packageConfig.skillVersion)) throw new Error('Package name/version/metadata must be explicit and valid');
const packageContracts = packageConfig.contracts;
if (!packageContracts || typeof packageContracts.ledger !== 'number' || !Number.isSafeInteger(packageContracts.ledger) || packageContracts.ledger < 1 || typeof packageContracts.api !== 'number' || !Number.isSafeInteger(packageContracts.api) || packageContracts.api < 1 || typeof packageContracts.frontend !== 'number' || !Number.isSafeInteger(packageContracts.frontend) || packageContracts.frontend < 1 || typeof packageContracts.viewer !== 'number' || !Number.isSafeInteger(packageContracts.viewer) || packageContracts.viewer < 1 || typeof packageContracts.service !== 'string' || !packageContracts.service) throw new Error('Package contract metadata is incomplete');
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const sourceSha = git('rev-parse', 'HEAD');
const dirty = Boolean(git('status', '--porcelain'));
if (!sha1.test(sourceSha)) throw new Error('Git source SHA is not a full commit SHA');
const mergeShaValue = process.env.LOOMHELM_MERGE_SHA?.trim() || null;
if (mergeShaValue !== null && !sha1.test(mergeShaValue)) throw new Error('LOOMHELM_MERGE_SHA must be a full commit SHA');
if (process.env.LOOMHELM_REQUIRE_MERGE_SHA === '1' && (dirty || mergeShaValue === null || mergeShaValue !== sourceSha)) throw new Error('Release package builds require a clean checkout at the exact merge SHA');
const gitTag = process.env.LOOMHELM_GIT_TAG?.trim() || null;
if (gitTag !== null && gitTag !== `multi-task-flow-v${packageMetadata.version}`) throw new Error('LOOMHELM_GIT_TAG does not match package version');
const tarballDigest = process.env.LOOMHELM_TARBALL_DIGEST?.trim() || null;
if (tarballDigest !== null && !sha256.test(tarballDigest)) throw new Error('LOOMHELM_TARBALL_DIGEST must be a SHA-256 digest');
// Only this exact disposable resource output is replaced. TS is never emitted.
if (existsSync(target)) {
  if (lstatSync(target).isSymbolicLink() || realpathSync(target) !== target) throw new Error('Unsafe toolkit output directory');
  rmSync(target, { recursive: true });
}
const outputs = new Map<string, { path: string; sha256: string }>();
function record(path: string, contents: Uint8Array): void {
  outputs.set(path, { path, sha256: createHash('sha256').update(contents).digest('hex') });
}
function copy(path: string, expected: string | undefined, dependency = false): void {
  const source = resolve(root, path);
  if (!path.startsWith('skills/') || !source.startsWith(resolve(root, 'skills') + '/')) throw new Error('Unsafe toolkit resource path');
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || (!dependency && stat.nlink !== 1) || realpathSync(source) !== source) throw new Error('Unsafe toolkit resource: ' + path);
  const contents = readFileSync(source);
  const digest = createHash('sha256').update(contents).digest('hex');
  if (expected && digest !== expected) throw new Error('Toolkit resource checksum mismatch: ' + path);
  const output = resolve(target, path); mkdirSync(dirname(output), { recursive: true });
  cpSync(source, output);
  record(path, contents);
}
function copyRootFile(path: string): void {
  const source = resolve(root, path);
  if (!source.startsWith(`${root}${sep}`)) throw new Error('Unsafe package resource path');
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(source) !== source) throw new Error('Unsafe package resource: ' + path);
  const contents = readFileSync(source);
  const output = resolve(target, path);
  mkdirSync(dirname(output), { recursive: true });
  cpSync(source, output);
}
function writeGenerated(path: string, contents: Uint8Array): void {
  const output = resolve(target, path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, contents);
  record(path, contents);
}
function copyPackageManifest(): void {
  const files = manifest.files.filter(file => !packageOmissionPaths.has(file.path));
  const additions = (manifest.additions ?? []).filter(file => !packageOmissionPaths.has(file.path));
  const packageManifest = { ...manifest, files, additions, packageOmissions };
  writeGenerated('skills/source-manifest.json', Buffer.from(JSON.stringify(packageManifest, null, 2) + '\n'));
}
for (const file of [...manifest.files, ...(manifest.additions ?? [])]) if (!packageOmissionPaths.has(file.path)) copy(file.path, file.installedSha256);
copyPackageManifest();
copy('skills/catalog.json');
for (const name of ['index.html','app.js','app.css']) copy(`skills/multi-task-flow/dist/${name}`);
const copyDependencies = (path: string): boolean => {
  const sourceRoot = resolve(root, path);
  if (!existsSync(sourceRoot)) {
    if (requireDependencies) throw new Error(`Prepared dependency directory missing: ${path}`);
    return false;
  }
  const rootStat = lstatSync(sourceRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(sourceRoot) !== sourceRoot) throw new Error('Unsafe dependency directory: ' + path);
  const copyBinLauncher = (child: string, source: string): void => {
    const resolvedSource = realpathSync(source);
    const relSource = relative(sourceRoot, resolvedSource);
    if (relSource.startsWith(`..${sep}`) || relSource === '..' || !lstatSync(resolvedSource).isFile()) throw new Error('Unsafe dependency launcher: ' + `${path}/${child}`);
    const outputPath = resolve(target, path, child);
    const targetPath = resolve(target, path, relSource);
    const targetRel = relative(dirname(outputPath), targetPath).split(sep).join('/');
    const launcher = `#!/usr/bin/env bun\nawait import(new URL(${JSON.stringify(targetRel)}, import.meta.url).href);\n`;
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, launcher, { mode: 0o755 });
    record(`${path}/${child}`, Buffer.from(launcher));
  };
  const recordPreparedFile = (destination: string, source: string): void => {
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(source) !== source) throw new Error('Unsafe prepared dependency: ' + destination);
    record(destination, readFileSync(source));
  };
  const walk = (relativePath: string): void => {
    for (const entry of readdirSync(resolve(sourceRoot, relativePath), { withFileTypes: true })) {
      if (entry.name === '.cache') continue;
      const child = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const source = resolve(sourceRoot, child);
      if (entry.isSymbolicLink()) {
        if (relativePath !== '.bin' && !relativePath.startsWith(`.bin${sep}`)) throw new Error('Unsafe dependency symlink: ' + `${path}/${child}`);
        if (productPartitionBuild) recordPreparedFile(`${path}/${child}`, realpathSync(source));
        else copyBinLauncher(child, source);
      } else if (entry.isDirectory()) walk(child);
      else if (productPartitionBuild) recordPreparedFile(`${path}/${child}`, source);
      else copy(`${path}/${child}`, undefined, true);
    }
  };
  walk('');
  return true;
};
const bundledDependencies = [copyDependencies('skills/node_modules'), copyDependencies('skills/multi-task-flow/node_modules')].filter(Boolean).length;
copyRootFile('AGENTS.md');
const packageIdentityBase = {
  packageName: packageMetadata.name,
  packageVersion: packageMetadata.version,
  compatibilityLine: packageConfig.compatibilityLine,
  skillVersion: packageConfig.skillVersion,
  sourceSha,
  mergeSha: mergeShaValue,
  contracts: { ledgerContract: packageContracts.ledger, apiVersion: packageContracts.api, frontendContract: packageContracts.frontend, viewerContract: packageContracts.viewer, serviceVersion: packageContracts.service },
  tarballDigest,
  gitTag,
};
const generatedPackage = JSON.stringify({ private: true, type: 'module', packageName: packageMetadata.name, packageVersion: packageMetadata.version, compatibilityLine: packageConfig.compatibilityLine, skillVersion: packageConfig.skillVersion }, null, 2) + '\n';
writeFileSync(resolve(target, 'package.json'), generatedPackage);
const finalInventory = [...outputs.values()].sort((left, right) => left.path.localeCompare(right.path));
const buildId = createHash('sha256').update(JSON.stringify({ ...packageIdentityBase, files: finalInventory })).digest('hex');
const identity = { ...packageIdentityBase, buildId };
const artifact = { schemaVersion: 2, packageName: packageMetadata.name, packageVersion: packageMetadata.version, compatibilityLine: packageConfig.compatibilityLine, skillVersion: packageConfig.skillVersion, sourceCommit: manifest.commit, sourceSha, mergeSha: mergeShaValue, candidateSha: sourceSha, dirty, runtime: 'bun@1.4.4', identity, buildId, tarballDigest, gitTag, dependenciesBundled: bundledDependencies === 2, omittedResources: packageOmissions, files: finalInventory };
writeFileSync(resolve(target, 'artifact-manifest.json'), JSON.stringify(artifact, null, 2) + '\n');
console.log(JSON.stringify({ artifact: target, package: packageMetadata.name, version: packageMetadata.version, compatibilityLine: packageConfig.compatibilityLine, runtime: 'bun@1.4.4', resources: finalInventory.length, dependenciesBundled: bundledDependencies === 2, source: sourceSha, merge: mergeShaValue, buildId, dirty }));
