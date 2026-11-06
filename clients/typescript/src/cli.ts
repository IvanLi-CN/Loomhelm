#!/usr/bin/env node
import { LocalClient } from './client.js';
import { StateLock } from './runtime/lock.js';
import { loadConfig } from './config.js';
import { GitAdapter } from './git.js';
import { runProcess } from './runtime/process.js';
import type { Operation } from './tasks/model.js';
import { runCodexCommand } from './cli/codex.js';
import { runFlowCommand } from './cli/flow.js';
import { fileURLToPath } from 'node:url';

async function main(args: string[]): Promise<void> {
  let configPath: string | undefined;
  if (args[0] === '--config') { args.shift(); configPath = args.shift(); if (!configPath) throw new Error('Missing config path'); }
  const [command, ...rest] = args;
  if (command === 'help' || !command) {
    console.log('loomhelm [--config PATH] status|tasks|receipts|recover-lock TOKEN|apply OPERATION_ID JSON|run OPERATION_ID TASK_ID COMMAND_JSON|git-status PATH|worktree REPO ABS_PATH BRANCH [BASE]|codex COMMAND ...|flow COMMAND ...|workflow COMMAND ...'); return;
  }
  if (command === 'codex') { await runCodexCommand(rest, configPath); return; }
  if (command === 'flow') { await runFlowCommand(rest, configPath); return; }
  if (command === 'workflow') {
    if (!rest.length) throw new Error('Usage: workflow skills PROJECT_SKILLS_DIR [USER_SKILLS_DIR] | verify MANIFEST_JSON_PATH');
    const result = await runProcess(process.execPath, [fileURLToPath(new URL('./workflow/cli.js', import.meta.url)), ...rest]);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.code !== 0) process.exitCode = result.code ?? 1;
    return;
  }
  if (command === 'recover-lock' && rest.length === 1) { await StateLock.recover((await loadConfig(configPath)).stateDir, rest[0]!); console.log(JSON.stringify({ recovered: true })); return; }
  if (command === 'git-status' && rest.length === 1) { console.log(JSON.stringify(await new GitAdapter(rest[0]!).inspect())); return; }
  if (command === 'worktree' && (rest.length === 3 || rest.length === 4)) {
    console.log(JSON.stringify(await new GitAdapter(rest[0]!).createWorktree(rest[1]!, rest[2]!, rest[3]))); return;
  }
  if (!['status', 'tasks', 'receipts', 'apply', 'run'].includes(command) || (command === 'apply' ? rest.length !== 2 : command === 'run' ? rest.length !== 3 : rest.length !== 0)) throw new Error('Invalid command; see help');
  const client = await LocalClient.open(configPath);
  const controller = new AbortController();
  const interrupt = () => { controller.abort(); process.exitCode = 130; };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    let output: unknown;
    switch (command) {
      case 'status': output = { mode: client.config.mode, stateDir: client.config.stateDir, tasks: Object.keys(client.ledger.snapshot().tasks).length }; break;
      case 'tasks': output = client.ledger.snapshot(); break;
      case 'receipts': output = client.ledger.history(); break;
      case 'run': {
        const [operationId, taskId, encoded] = rest as [string, string, string];
        if (operationId.length > 80) throw new Error('Run operation identity is too long');
        const argv: unknown = JSON.parse(encoded);
        if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string') || !argv[0]) throw new Error('Command must be a nonempty string array');
        const runId = `${operationId}.run`;
        const start = { type: 'run.start' as const, taskId, runId, command: argv as string[] };
        const existing = client.ledger.history().find(r => r.operationId === `${operationId}.start`);
        await client.ledger.execute(`${operationId}.start`, start);
        if (existing) {
          const finished = client.ledger.history().find(r => r.operationId === `${operationId}.finish`);
          if (!finished) throw new Error('Uncertain previous execution; inspect receipts before explicit retry with a new identity');
          output = finished;
          if (finished.operation.type === 'run.finish' && finished.operation.status !== 'succeeded') process.exitCode = 1;
          break;
        }
        let status: 'succeeded' | 'failed' | 'interrupted' = 'failed';
        let detail: string;
        try {
          const result = await runProcess(argv[0], argv.slice(1), {
            ...(client.ledger.snapshot().tasks[taskId]?.repository ? { cwd: client.ledger.snapshot().tasks[taskId]!.repository! } : {}),
            timeoutMs: client.config.processTimeoutMs, signal: controller.signal,
          });
          status = result.code === 0 ? 'succeeded' : 'failed';
          detail = JSON.stringify(result);
        } catch (error) {
          status = controller.signal.aborted ? 'interrupted' : 'failed';
          detail = error instanceof Error ? error.message : String(error);
        }
        output = await client.ledger.execute(`${operationId}.finish`, { type: 'run.finish', runId, status, detail });
        if (status !== 'succeeded') process.exitCode = controller.signal.aborted ? 130 : 1;
        break;
      }
      case 'apply': output = await client.ledger.execute(rest[0]!, JSON.parse(rest[1]!) as Operation); break;
    }
    console.log(JSON.stringify(output));
  } finally {
    await client.close(); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
}
main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ code: 'CLI_ERROR', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });
