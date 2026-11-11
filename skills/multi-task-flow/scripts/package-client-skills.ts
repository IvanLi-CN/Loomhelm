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
const productBuildVersion = process.env.LOOMHELM_PRODUCT_BUILD_VERSION?.trim() || null;
const exactSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const compatibilityLine = /^compat-v([1-9]\d*)$/;
const sha1 = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;
const packageOmissions = [
  { path: 'skills/multi-task-flow/.gitignore', reason: 'package-root .gitignore is omitted by npm-compatible package archives' },
  { path: 'AGENTS.md', reason: 'repository instructions are package metadata, not a runtime Skill resource' },
  { path: 'package.json', reason: 'generated toolkit metadata is validated as package metadata, not a Skill resource' },
  { path: 'artifact-manifest.json', reason: 'the artifact manifest validates itself through identity and inventory checks' },
];
const packageOmissionPaths = new Set(packageOmissions.map(item => item.path));
const safeSemver = (value: unknown): value is string => {
  if (typeof value !== 'string' || !exactSemver.test(value)) return false;
  const [major, minor, patch] = value.split('-', 1)[0]!.split('.').map(Number);
  return [major, minor, patch].every(Number.isSafeInteger) && !value.split('-')[1]?.split('.').some(part => /^0\d+$/.test(part));
};
const buildVersion = productBuildVersion ?? packageMetadata.version;
if (packageMetadata.name !== '@loomhelm/multi-task-flow' || !safeSemver(packageMetadata.version) || !safeSemver(buildVersion) || !packageConfig || typeof packageConfig.compatibilityLine !== 'string' || !compatibilityLine.test(packageConfig.compatibilityLine) || typeof packageConfig.skillVersion !== 'string' || !safeSemver(packageConfig.skillVersion)) throw new Error('Package name/version/metadata must be explicit and valid');
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
if (gitTag !== null && gitTag !== `multi-task-flow-v${buildVersion}`) throw new Error('LOOMHELM_GIT_TAG does not match package version');
const tarballDigest = process.env.LOOMHELM_TARBALL_DIGEST?.trim() || null;
if (tarballDigest !== null && !sha256.test(tarballDigest)) throw new Error('LOOMHELM_TARBALL_DIGEST must be a SHA-256 digest');
type DependencyDeclaration = { name: string; version: string; resourceRoot: string };
type PreparedDependency = { name: string; version: string; path: string; entry: string };
const dependencyDeclarations = new Map<string, DependencyDeclaration>();
function declareDependencies(metadata: { dependencies?: Record<string, string> }, resourceRoot: string): void {
  for (const [name, version] of Object.entries(metadata.dependencies ?? {})) {
    const existing = dependencyDeclarations.get(name);
    if (existing) {
      if (existing.version !== version) throw new Error(`Conflicting dependency declaration: ${name}`);
      continue;
    }
    dependencyDeclarations.set(name, { name, version, resourceRoot });
  }
}
const skillsPackageMetadata = JSON.parse(readFileSync(resolve(root, 'skills/package.json'), 'utf8')) as { dependencies?: Record<string, string> };
const flowPackageMetadata = JSON.parse(readFileSync(resolve(root, 'skills/multi-task-flow/package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
declareDependencies(skillsPackageMetadata, 'skills/node_modules');
declareDependencies(flowPackageMetadata, 'skills/multi-task-flow/node_modules');
if (flowPackageMetadata.devDependencies?.playwright) dependencyDeclarations.set('playwright', { name: 'playwright', version: flowPackageMetadata.devDependencies.playwright, resourceRoot: 'skills/multi-task-flow/node_modules' });
const requiredDependencies = [...dependencyDeclarations.values()].sort((left, right) => left.name.localeCompare(right.name));
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
function dependencyMetadata(sourceRoot: string, name: string, expectedVersion: string): { name: string; version: string; entry: string } {
  const dependencyBase = resolve(root, sourceRoot);
  const packageRoot = resolve(dependencyBase, name);
  if (!packageRoot.startsWith(`${dependencyBase}${sep}`)) throw new Error(`Unsafe prepared dependency path: ${name}`);
  const packageJsonPath = resolve(packageRoot, 'package.json');
  if (!existsSync(packageJsonPath)) throw new Error(`Prepared dependency missing: ${name}`);
  const metadata = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: string; version?: string; module?: string; main?: string };
  if (metadata.name !== name || metadata.version !== expectedVersion) throw new Error(`Prepared dependency version mismatch: ${name}`);
  const declaredEntry = metadata.module ?? metadata.main ?? 'index.js';
  const candidates = [declaredEntry, `${declaredEntry}.js`, `${declaredEntry}.mjs`, `${declaredEntry}.cjs`, `${declaredEntry}/index.js`];
  const entry = candidates.find(candidate => {
    const sourceEntry = resolve(packageRoot, candidate);
    return sourceEntry.startsWith(`${packageRoot}${sep}`) && existsSync(sourceEntry) && lstatSync(sourceEntry).isFile() && realpathSync(sourceEntry) === sourceEntry;
  });
  if (!entry) throw new Error(`Unsafe prepared dependency entry: ${name}`);
  return { name, version: expectedVersion, entry: entry.replace(/^\.\//, '') };
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
  const resolvedRoot = realpathSync(sourceRoot);
  let preparedFiles = 0;
  const copyBinLauncher = (child: string, source: string): void => {
    const resolvedSource = realpathSync(source);
    const relSource = relative(sourceRoot, resolvedSource);
    if (relative(resolvedRoot, resolvedSource).startsWith(`..${sep}`) || relative(resolvedRoot, resolvedSource) === '..' || relSource.startsWith(`..${sep}`) || relSource === '..' || !lstatSync(resolvedSource).isFile()) throw new Error('Unsafe dependency launcher: ' + `${path}/${child}`);
    const outputPath = resolve(target, path, child);
    const targetPath = resolve(target, path, relSource);
    const targetRel = relative(dirname(outputPath), targetPath).split(sep).join('/');
    const launcher = `#!/usr/bin/env bun\nawait import(new URL(${JSON.stringify(targetRel)}, import.meta.url).href);\n`;
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, launcher, { mode: 0o755 });
    record(`${path}/${child}`, Buffer.from(launcher));
  };
  const recordPreparedFile = (destination: string, source: string): void => {
    const resolvedSource = realpathSync(source);
    const relativeSource = relative(resolvedRoot, resolvedSource);
    const stat = lstatSync(source);
    if (relativeSource.startsWith(`..${sep}`) || relativeSource === '..' || !stat.isFile() || stat.isSymbolicLink() || resolvedSource !== source) throw new Error('Unsafe prepared dependency: ' + destination);
    record(destination, readFileSync(resolvedSource));
    preparedFiles += 1;
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
  return preparedFiles > 0;
};
const prepareDependencyShims = (): PreparedDependency[] => {
  const prepared: PreparedDependency[] = [];
  for (const dependency of requiredDependencies) {
    const metadata = dependencyMetadata('clients/typescript/node_modules', dependency.name, dependency.version);
    const shimRoot = `skills/node_modules/${dependency.name}`;
    writeGenerated(`${shimRoot}/package.json`, Buffer.from(JSON.stringify({ name: dependency.name, version: dependency.version, type: 'module', private: true }, null, 2) + '\n'));
    const output = resolve(target, shimRoot, 'index.js');
    const packageEntry = resolve(target, '..', 'node_modules', dependency.name, metadata.entry);
    const targetRel = relative(dirname(output), packageEntry).split(sep).join('/');
    const wrapper = `import * as packageExports from ${JSON.stringify(targetRel)};\nexport default packageExports.default;\nexport * from ${JSON.stringify(targetRel)};\n`;
    writeGenerated(`${shimRoot}/index.js`, Buffer.from(wrapper));
    prepared.push({ name: dependency.name, version: dependency.version, path: shimRoot, entry: 'index.js' });
  }
  return prepared;
};
let preparedDependencies: PreparedDependency[];
if (productPartitionBuild) {
  for (const resourceRoot of new Set(requiredDependencies.map(dependency => dependency.resourceRoot))) copyDependencies(resourceRoot);
  preparedDependencies = requiredDependencies.map(dependency => {
    const metadata = dependencyMetadata(dependency.resourceRoot, dependency.name, dependency.version);
    const path = `${dependency.resourceRoot}/${dependency.name}`;
    if (!outputs.has(`${path}/package.json`)) throw new Error(`Prepared dependency was not copied: ${dependency.name}`);
    return { name: dependency.name, version: dependency.version, path, entry: metadata.entry };
  });
} else {
  preparedDependencies = prepareDependencyShims();
}
const dependenciesBundled = preparedDependencies.length === requiredDependencies.length && requiredDependencies.length > 0;
if (requireDependencies && !dependenciesBundled) throw new Error('Prepared dependency closure is incomplete');
copyRootFile('AGENTS.md');
const packageIdentityBase = {
  packageName: packageMetadata.name,
  packageVersion: buildVersion,
  compatibilityLine: packageConfig.compatibilityLine,
  skillVersion: packageConfig.skillVersion,
  sourceSha,
  mergeSha: productPartitionBuild ? mergeShaValue ?? sourceSha : mergeShaValue,
  dirty,
  contracts: { ledgerContract: packageContracts.ledger, apiVersion: packageContracts.api, frontendContract: packageContracts.frontend, viewerContract: packageContracts.viewer, serviceVersion: packageContracts.service },
  tarballDigest,
  gitTag,
};
const generatedPackage = JSON.stringify({ private: true, type: 'module', packageName: packageMetadata.name, packageVersion: buildVersion, compatibilityLine: packageConfig.compatibilityLine, skillVersion: packageConfig.skillVersion }, null, 2) + '\n';
writeFileSync(resolve(target, 'package.json'), generatedPackage);
const finalInventory = [...outputs.values()].sort((left, right) => left.path.localeCompare(right.path));
const buildId = createHash('sha256').update(JSON.stringify({ ...packageIdentityBase, files: finalInventory })).digest('hex');
const identity = { ...packageIdentityBase, buildId };
const artifact = { schemaVersion: 2, packageName: packageMetadata.name, packageVersion: buildVersion, compatibilityLine: packageConfig.compatibilityLine, skillVersion: packageConfig.skillVersion, sourceCommit: manifest.commit, sourceSha, mergeSha: packageIdentityBase.mergeSha, candidateSha: sourceSha, dirty, runtime: 'bun@1.4.4', identity, buildId, tarballDigest, gitTag, dependenciesBundled, dependencies: preparedDependencies, omittedResources: packageOmissions, files: finalInventory };
writeFileSync(resolve(target, 'artifact-manifest.json'), JSON.stringify(artifact, null, 2) + '\n');
console.log(JSON.stringify({ artifact: target, package: packageMetadata.name, version: buildVersion, compatibilityLine: packageConfig.compatibilityLine, runtime: 'bun@1.4.4', resources: finalInventory.length, dependenciesBundled, source: sourceSha, merge: packageIdentityBase.mergeSha, buildId, dirty }));
