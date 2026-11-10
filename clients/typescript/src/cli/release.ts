import { compatibilityDistTag, validatePublication } from '../release.ts';

export async function runReleaseCommand(args: string[]): Promise<void> {
  if (args[0] === 'help' || !args.length) {
    console.log('release validate --version VERSION [--dist-tag VERSION|compat-vN]');
    return;
  }
  if (args[0] !== 'validate') throw new Error('Usage: release validate --version VERSION [--dist-tag VERSION|compat-vN]');
  let version: string | undefined;
  let distTag: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--version') version = args[++index];
    else if (option === '--dist-tag') distTag = args[++index];
    else throw new Error(`Unknown release option: ${option}`);
  }
  if (!version) throw new Error('Missing --version');
  const publication = validatePublication(version, distTag);
  console.log(JSON.stringify({ ...publication, compatibilityVersion: distTag?.startsWith('compat-v') ? Number(distTag.slice('compat-v'.length)) : null }));
}

export function defaultCompatibilityTag(version: string): string {
  return compatibilityDistTag(validatePublication(version).version.major);
}
