import { randomUUID } from 'node:crypto';
import { runProcess } from '@loomhelm/runtime-core/modules/core/process.ts';
import type { ProcessOptions, ProcessResult } from './process.ts';

/** Flow forwards bytes; the generic captured-process API keeps its old defaults. */
export async function runFlowProcess(command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  const invocationId = randomUUID();
  let send: ((message: unknown) => void) | undefined;
  let resolveStop!: () => void;
  const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
  let bytes = 0;
  let deliveryError: Error | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const signal of signals) process.on(signal, abort);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const result = await runProcess({
      command, args: [...args],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { ...process.env, ...options.env, LOOMHELM_INVOCATION_ID: invocationId },
      ...(options.input === undefined ? {} : { stdin: typeof options.input === 'string' ? options.input : new TextDecoder().decode(options.input) }),
      timeoutMs: options.timeoutMs ?? 30_000,
      signal: controller.signal,
      maxCapturedOutputBytes: 0,
      propagateParentSignal: false,
      onSpawn: control => { send = control.send; },
      onControlMessage: message => {
        if (message && typeof message === 'object' && 'invocation_id' in message &&
          message.invocation_id === invocationId && 'type' in message && message.type === 'stopped') resolveStop();
      },
      cooperativeStop: async () => {
        send?.({ type: 'stop', invocation_id: invocationId });
        await stopped;
      },
      cooperativeStopTimeoutMs: 200_000,
      outputSink: async (stream, chunk) => {
        bytes += chunk.byteLength;
        if (deliveryError) return; // Drain without buffering while the child closes its resources.
        if (options.maxOutputBytes !== undefined && bytes > options.maxOutputBytes) {
          deliveryError = new Error('Process output limit exceeded');
          controller.abort();
          return;
        }
        try { await options.outputSink!(stream, chunk); }
        catch (error) {
          deliveryError = error instanceof Error ? error : new Error(String(error));
          controller.abort();
        }
      },
    });
    if (deliveryError) throw deliveryError;
    if (result.timedOut) throw new Error('Process timed out; inspect invocation stop evidence');
    if (controller.signal.aborted) throw new Error('Process aborted; inspect invocation stop evidence');
    return { code: result.exitCode, signal: null, stdout: '', stderr: '' };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    for (const signal of signals) process.off(signal, abort);
  }
}
