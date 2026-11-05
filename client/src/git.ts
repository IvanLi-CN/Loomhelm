import { lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { runProcess } from './runtime/process.js';

export class GitAdapter {
  constructor(readonly directory: string, private timeoutMs = 30_000) {}
  private async git(args: string[]): Promise<string> {
    const result = await runProcess('git', ['-C', this.directory, ...args], { timeoutMs: this.timeoutMs });
    if (result.code !== 0) throw new Error(`Git failed (${result.code}): ${result.stderr.trim()}`);
    return result.stdout;
  }
  async inspect(): Promise<{ root: string; head: string; branch: string | null; dirty: boolean }> {
    const root = (await this.git(['rev-parse', '--show-toplevel'])).trim();
    const head = (await this.git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    const branch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const status = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return { root, head, branch: branch === 'HEAD' ? null : branch, dirty: status.length > 0 };
  }
  /** Creates only; never cleans, resets, removes, pushes or reconfigures repositories. */
  async createWorktree(destination: string, branch: string, base = 'HEAD'): Promise<{ path: string; branch: string; head: string }> {
    if (!isAbsolute(destination) || !branch || branch.startsWith('-') || !base || base.startsWith('-')) throw new Error('Absolute path and valid refs required');
    await this.git(['check-ref-format', '--branch', branch]);
    const current = await this.inspect();
    if (current.dirty) throw new Error('Source worktree is dirty');
    const path = resolve(destination);
    try { await lstat(path); throw new Error('Worktree destination already exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const head = (await this.git(['rev-parse', '--verify', `${base}^{commit}`])).trim();
    await this.git(['worktree', 'add', '-b', branch, '--', path, head]);
    return { path, branch, head };
  }
}
