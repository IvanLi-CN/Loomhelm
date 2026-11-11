import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildInfoFromArtifact, requirePublishableArtifact } from '../runtime-identity.ts';
import { commitForGitTag, canonicalTarballDigest, gitSourceSha, gitWorkingTreeStatus, packPackageTarball, removeTarballDirectory } from '../release-tarball.ts';
import { SkillsRuntime } from '../toolkit.ts';
import { parseCompatibilityDistTag, validatePublication } from '../release.ts';

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function repositoryRoot(): string {
  return execFileSync('git', ['-C', packageRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function assertGitTagProvenance(sourceSha: string, version: string, repoRoot = repositoryRoot()): void {
  const tag = `multi-task-flow-v${version}`;
  let taggedSha: string;
  try { taggedSha = commitForGitTag(repoRoot, tag); } catch { throw new Error(`Publication requires Git tag ${tag} at source SHA ${sourceSha}`); }
  if (taggedSha !== sourceSha) throw new Error(`Publication Git tag does not point to artifact source: ${tag}`);
}

function parsePublicationArgs(args: string[]): { version?: string; distTag?: string; compatibilityLine?: string } {
  let version: string | undefined;
  let distTag: string | undefined;
  let compatibilityLine: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--version') version = args[++index];
    else if (option === '--dist-tag') distTag = args[++index];
    else if (option === '--compatibility-line') compatibilityLine = args[++index];
    else throw new Error(`Unknown release option: ${option}`);
  }
  return {
    ...(version === undefined ? {} : { version }),
    ...(distTag === undefined ? {} : { distTag }),
    ...(compatibilityLine === undefined ? {} : { compatibilityLine }),
  };
}

async function runPublishCommand(args: string[]): Promise<void> {
  const options = parsePublicationArgs(args);
  const packageMetadata = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as { version?: string };
  const version = options.version ?? packageMetadata.version;
  if (!version) throw new Error('Missing package version');
  const publication = validatePublication(version, options.distTag);
  const repoRoot = repositoryRoot();
  if (gitWorkingTreeStatus(repoRoot).trim()) throw new Error('Publication requires a clean Git checkout');
  const sourceSha = gitSourceSha(repoRoot);
  assertGitTagProvenance(sourceSha, version, repoRoot);
  const gitTag = `multi-task-flow-v${version}`;
  const buildScript = resolve(repoRoot, 'skills/multi-task-flow/scripts/package-client-skills.ts');
  const buildEnvironment = (tarballDigest = '') => ({ ...process.env, LOOMHELM_REQUIRE_MERGE_SHA: '1', LOOMHELM_MERGE_SHA: sourceSha, LOOMHELM_GIT_TAG: gitTag, LOOMHELM_TARBALL_DIGEST: tarballDigest });
  const build = (tarballDigest = '') => execFileSync(process.execPath, ['--no-install', buildScript, '--require-dependencies'], { cwd: packageRoot, env: buildEnvironment(tarballDigest), stdio: 'inherit' });
  const tarballs: string[] = [];
  try {
    build();
    const draft = packPackageTarball(packageRoot);
    tarballs.push(draft);
    const digest = canonicalTarballDigest(draft);
    build(digest);
    const finalTarball = packPackageTarball(packageRoot);
    tarballs.push(finalTarball);
    if (canonicalTarballDigest(finalTarball) !== digest) throw new Error('Tarball digest changed after embedding provenance');
    const artifact = await new SkillsRuntime().validate();
    const identity = requirePublishableArtifact(artifact);
    if (identity.packageVersion !== version || identity.tarballDigest !== digest) throw new Error('Packaged provenance does not match the publication request');
    if (options.compatibilityLine !== undefined && options.compatibilityLine !== identity.compatibilityLine) throw new Error('Declared compatibility line does not match artifact identity');
    execFileSync(process.execPath, ['publish', '--tag', publication.distTag, finalTarball], { cwd: packageRoot, env: buildEnvironment(digest), stdio: 'inherit' });
    console.log(JSON.stringify({ ...publication, packageName: identity.packageName, sourceSha, mergeSha: identity.mergeSha, buildId: identity.buildId, tarballDigest: digest, gitTag }));
  } finally {
    for (const tarball of tarballs) removeTarballDirectory(tarball);
  }
}

export async function runReleaseCommand(args: string[]): Promise<void> {
  if (args[0] === 'help' || !args.length) {
    console.log('release identity | validate --version VERSION [--dist-tag VERSION|compat-vN] [--compatibility-line compat-vN] [--require-provenance] | publish [--version VERSION] --dist-tag VERSION|compat-vN [--compatibility-line compat-vN]');
    return;
  }
  if (args[0] === 'publish') { await runPublishCommand(args.slice(1)); return; }
  const artifact = await new SkillsRuntime().validate();
  const buildInfo = buildInfoFromArtifact(artifact);
  if (args[0] === 'identity' && args.length === 1) {
    console.log(JSON.stringify(buildInfo));
    return;
  }
  if (args[0] !== 'validate') throw new Error('Usage: release identity | validate --version VERSION [--dist-tag VERSION|compat-vN] [--compatibility-line compat-vN] [--require-provenance] | publish [--version VERSION] --dist-tag VERSION|compat-vN [--compatibility-line compat-vN]');
  const publicationArgs = parsePublicationArgs(args.slice(1).filter(option => option !== '--require-provenance'));
  let version = publicationArgs.version;
  let distTag = publicationArgs.distTag;
  let compatibilityLine = publicationArgs.compatibilityLine;
  let requireProvenance = false;
  requireProvenance = args.includes('--require-provenance');
  if (!version) throw new Error('Missing --version');
  if (version !== buildInfo.version) throw new Error(`Publication version does not match artifact version: ${version}`);
  if (compatibilityLine !== undefined && compatibilityLine !== buildInfo.compatibility_line) throw new Error('Declared compatibility line does not match artifact identity');
  if (requireProvenance) {
    const identity = requirePublishableArtifact(artifact);
    assertGitTagProvenance(identity.sourceSha, identity.packageVersion);
  }
  const publication = validatePublication(version, distTag);
  const declaredLine = buildInfo.compatibility_line;
  if (declaredLine) {
    parseCompatibilityDistTag(declaredLine);
    if (distTag && distTag !== version && distTag !== declaredLine) throw new Error('Publication dist-tag does not match the declared compatibility line');
  }
  console.log(JSON.stringify({
    ...publication,
    packageName: buildInfo.package_name,
    compatibilityLine: declaredLine,
    sourceSha: buildInfo.source_sha,
    mergeSha: buildInfo.merge_sha,
    buildId: buildInfo.build_id,
    tarballDigest: buildInfo.tarball_digest,
  }));
}
