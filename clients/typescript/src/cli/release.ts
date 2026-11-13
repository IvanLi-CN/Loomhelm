import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildInfoFromArtifact, requirePublishableArtifact } from '../runtime-identity.ts';
import { commitForGitTag } from '../release-tarball.ts';
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

export async function runReleaseCommand(args: string[]): Promise<void> {
  if (args[0] === 'help' || !args.length) {
    console.log('release identity | validate --version VERSION [--dist-tag VERSION|compat-vN] [--compatibility-line compat-vN] [--require-provenance]');
    return;
  }
  if (args[0] === 'publish') throw new Error('Direct npm publication is disabled; use the protected Skill Runtime Release workflow');
  const artifact = await new SkillsRuntime().validate();
  const buildInfo = buildInfoFromArtifact(artifact);
  if (args[0] === 'identity' && args.length === 1) {
    console.log(JSON.stringify(buildInfo));
    return;
  }
  if (args[0] !== 'validate') throw new Error('Usage: release identity | validate --version VERSION [--dist-tag VERSION|compat-vN] [--compatibility-line compat-vN] [--require-provenance]');
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
