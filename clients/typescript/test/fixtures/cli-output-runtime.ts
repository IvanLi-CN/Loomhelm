// Disposable transport fixture. Never loads an installed service or native Codex.
import { appendFileSync } from 'node:fs';
import { SkillsRuntime } from '../../src/toolkit.ts';
SkillsRuntime.prototype.run = async function (script, args = [], options = {}) {
  const input = options.input ? JSON.parse(Buffer.from(options.input as Uint8Array).toString()) : null;
  if (process.env.CLI_OUTPUT_CALL_LOG) appendFileSync(process.env.CLI_OUTPUT_CALL_LOG, JSON.stringify({ script, args, input }) + '\n');
  let value: unknown;
  if (script.endsWith('/service.ts')) value = { ok: true, code: 'OK', result: { installed: false, running: false } };
  else if (input?.actor?.thread_id !== 'bound-thread') value = { ok: false, code: 'ACTOR_MISMATCH', revision: null, message: 'Conversation is not bound to the run', details: {} };
  else value = { ok: true, code: 'OK', revision: 7, result: { run_id: input.run_id, section: input.section ?? 'full' }, invocation: { state: 'running', quiescent: false, missing_evidence: ['receipt'] } };
  const text = JSON.stringify(value) + '\n';
  if (options.outputSink) {
    const bytes = Buffer.from(text);
    for (let at = 0; at < bytes.length; at += 7) await options.outputSink('stdout', bytes.subarray(at, at + 7));
    return { code: (value as { ok: boolean }).ok ? 0 : 3, signal: null, stdout: '', stderr: '' };
  }
  return { code: 0, signal: null, stdout: text, stderr: '' };
};
if (process.env.CLI_OUTPUT_TTY === '1') Object.defineProperty(process.stdout, 'isTTY', { value: true });
await import('../../src/cli.ts');
