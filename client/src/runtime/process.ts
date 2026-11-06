import { spawn } from 'node:child_process';

export interface ProcessResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
export interface ProcessOptions { cwd?: string; timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }
/** Owns only its direct child; no detached services or shell expansion. */
export function runProcess(command: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  const timeout = options.timeoutMs ?? 30_000;
  const limit = options.maxOutputBytes ?? 1024 * 1024;
  if (typeof command !== 'string' || !command.trim() || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) return Promise.reject(new Error('Invalid process command'));
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647 || !Number.isSafeInteger(limit) || limit < 1) return Promise.reject(new Error('Invalid process limits'));
  if (options.signal?.aborted) return Promise.reject(new Error('Process aborted'));
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { cwd: options.cwd, env: options.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, failure: Error | undefined, escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: Error) => {
      if (failure) return;
      failure = reason;
      child.kill('SIGTERM');
      // Keep the streams alive until close so callers get a deterministic
      // completion point even when a child exits while it is being stopped.
      escalation = setTimeout(() => child.kill('SIGKILL'), 250);
    };
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) stop(new Error('Process output limit exceeded'));
      else chunks.push(chunk);
    };
    child.stdout!.on('data', collect(stdout)); child.stderr!.on('data', collect(stderr));
    const abort = () => stop(new Error('Process aborted'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new Error('Process timed out')), timeout);
    child.once('error', error => { failure = error; });
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation); options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}
