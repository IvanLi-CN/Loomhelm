import { buildInfo } from '../build-info.ts';
import { isCompatibilityDistTag, parseCompatibilityDistTag, validatePublication } from '../release.ts';

export async function runReleaseCommand(args: string[]): Promise<void> {
  if (args[0] === 'help' || !args.length) {
    console.log('release identity | validate --version VERSION [--dist-tag VERSION|compat-vN] [--compatibility-line compat-vN]');
    return;
  }
  if (args[0] === 'identity' && args.length === 1) {
    console.log(JSON.stringify(buildInfo));
    return;
  }
  if (args[0] !== 'validate') throw new Error('Usage: release identity | validate --version VERSION [--dist-tag VERSION|compat-vN] [--compatibility-line compat-vN]');
  let version: string | undefined;
  let distTag: string | undefined;
  let compatibilityLine: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--version') version = args[++index];
    else if (option === '--dist-tag') distTag = args[++index];
    else if (option === '--compatibility-line') compatibilityLine = args[++index];
    else throw new Error(`Unknown release option: ${option}`);
  }
  if (!version) throw new Error('Missing --version');
  const publication = validatePublication(version, distTag);
  const declaredLine = compatibilityLine ?? (isCompatibilityDistTag(buildInfo.compatibility_line) ? buildInfo.compatibility_line : undefined);
  if (declaredLine) {
    parseCompatibilityDistTag(declaredLine);
    if (distTag && distTag !== version && distTag !== declaredLine) throw new Error('Publication dist-tag does not match the declared compatibility line');
  }
  console.log(JSON.stringify({
    ...publication,
    packageName: buildInfo.package_name,
    compatibilityLine: declaredLine ?? null,
    sourceSha: buildInfo.source_sha,
    mergeSha: buildInfo.merge_sha,
    buildId: buildInfo.build_id,
    tarballDigest: buildInfo.tarball_digest,
  }));
}
