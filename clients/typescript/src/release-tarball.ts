import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function walkFiles(root: string, relativePath = ''): string[] {
  const directory = resolve(root, relativePath);
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Tarball contains a symbolic link: ${child}`);
    if (entry.isDirectory()) files.push(...walkFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Tarball contains an unsupported entry: ${child}`);
  }
  return files;
}

/** Hashes archive contents without the self-referential artifact manifest. */
export function canonicalTarballDigest(tarballPath: string): string {
  const extractionRoot = mkdtempSync(join(tmpdir(), 'loomhelm-tarball-'));
  try {
    execFileSync('tar', ['-xzf', resolve(tarballPath), '-C', extractionRoot], { stdio: 'ignore' });
    const packageRoot = resolve(extractionRoot, 'package');
    if (!lstatSync(packageRoot).isDirectory()) throw new Error('Tarball does not contain a package root');
    const files = walkFiles(packageRoot).sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
    const hash = createHash('sha256');
    for (const path of files) {
      if (path === 'toolkit/artifact-manifest.json') continue;
      hash.update(path);
      hash.update('\0');
      hash.update(readFileSync(resolve(packageRoot, path)));
      hash.update('\0');
    }
    return hash.digest('hex');
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

export function packPackageTarball(packageRoot: string): string {
  const destination = mkdtempSync(join(tmpdir(), 'loomhelm-package-'));
  execFileSync(process.execPath, ['pm', 'pack', '--destination', destination, '--ignore-scripts', '--quiet'], { cwd: packageRoot, stdio: 'inherit' });
  const archives = readdirSync(destination).filter(entry => entry.endsWith('.tgz'));
  if (archives.length !== 1) throw new Error('Package manager did not produce exactly one tarball');
  const tarballPath = join(destination, archives[0]!);
  if (!existsSync(tarballPath)) throw new Error('Package manager did not produce the expected tarball');
  return tarballPath;
}

export function commitForGitTag(repoRoot: string, tag: string): string {
  return execFileSync('git', ['-C', repoRoot, 'rev-parse', `refs/tags/${tag}^{commit}`], { encoding: 'utf8' }).trim();
}

export function gitSourceSha(repoRoot: string): string {
  return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export function gitWorkingTreeStatus(repoRoot: string): string {
  return execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' });
}

export function removeTarballDirectory(tarballPath: string): void {
  rmSync(dirname(tarballPath), { recursive: true, force: true });
}
