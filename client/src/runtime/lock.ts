import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export class StateLock {
  private constructor(private path: string, private token: string) {}
  static async acquire(directory: string): Promise<StateLock> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'writer.lock');
    const token = randomUUID();
    const file = await open(path, 'wx', 0o600).catch(error => {
      if (error.code === 'EEXIST') throw new Error(`State directory locked: ${path}; inspect owner before explicit recovery`);
      throw error;
    });
    try { await file.writeFile(JSON.stringify({ token, pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() })); await file.sync(); }
    finally { await file.close(); }
    return new StateLock(path, token);
  }
  /** Explicit repair only: exact token, same host and a demonstrably dead PID. */
  static async recover(directory: string, expectedToken: string): Promise<void> {
    const guardPath = join(directory, 'writer.recovery.lock');
    const guard = await open(guardPath, 'wx', 0o600);
    try {
      const path = join(directory, 'writer.lock');
      const original = await readFile(path, 'utf8');
      const owner = JSON.parse(original);
      if (!expectedToken || owner.token !== expectedToken || owner.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Lock recovery identity mismatch');
      try { process.kill(owner.pid, 0); throw new Error('Lock owner is alive'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      if (await readFile(path, 'utf8') !== original) throw new Error('Lock ownership changed');
      await unlink(path);
    } finally { await guard.close(); await unlink(guardPath); }
  }
  async release(): Promise<void> {
    const owner = JSON.parse(await readFile(this.path, 'utf8'));
    if (owner.token !== this.token) throw new Error('Lock ownership changed');
    await unlink(this.path);
  }
}
