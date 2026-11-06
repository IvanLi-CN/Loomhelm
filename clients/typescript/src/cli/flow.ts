import { loadConfig } from '../config.js';
import { SkillsRuntime } from '../toolkit.js';

export async function runFlowCommand(args: string[], configPath?: string): Promise<void> {
  if (args[0] === 'help' || !args.length) {
    console.log('flow COMMAND --input - [--socket PATH]; original Multi-task Flow JSON contract, schema_version=2 / contract_version=2'); return;
  }
  let socket: string | undefined;
  const index = args.indexOf('--socket');
  if (index >= 0) {
    socket = args[index + 1];
    if (!socket) throw new Error('Missing socket path');
    args = [...args.slice(0, index), ...args.slice(index + 2)];
  }
  if (args.length !== 3 || args[1] !== '--input' || args[2] !== '-') throw new Error('FLOW_LEGACY_ARGUMENTS_UNSUPPORTED: use COMMAND --input - with the original JSON contract; existing state is unchanged');
  const config = await loadConfig(configPath);
  if (process.stdin.isTTY) throw new Error('Flow requires a JSON request on stdin');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.from(chunk); size += data.length;
    if (size > 16 * 1024 * 1024) throw new Error('Flow input too large');
    chunks.push(data);
  }
  const selected = socket ?? config.codexAppServerSocket;
  const result = await new SkillsRuntime().run('skills/multi-task-flow/scripts/orchestrate.ts', args, {
    input: Buffer.concat(chunks), timeoutMs: config.processTimeoutMs, maxOutputBytes: config.maxOutputBytes,
    env: { ...process.env, ...(selected ? { LOOMHELM_CODEX_APP_SERVER_SOCKET: selected } : {}) },
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  process.exitCode = result.code ?? 1;
}
