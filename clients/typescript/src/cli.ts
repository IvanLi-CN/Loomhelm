#!/usr/bin/env -S bun --no-install
import { parseGlobalOptions, GlobalOptionsError } from './cli/output-options.ts';
import { output, printResult, printCaptured } from './cli/output.ts';
import { requestedHelp, printHelp } from './cli/help.ts';
import { LocalClient } from './client.ts';
import { StateLock } from './runtime/lock.ts';
import { loadConfig } from './config.ts';
import { GitAdapter } from './git.ts';
import { runProcess } from './runtime/process.ts';
import type { Operation } from './tasks/model.ts';
import { runCodexCommand } from './cli/codex.ts';
import { runSkillsCommand } from './cli/skills.ts';
import { runFlowCommand } from './cli/flow.ts';
import { runServiceCommand } from './cli/service.ts';
import { runReleaseCommand } from './cli/release.ts';
import { buildInfoFromArtifact } from './runtime-identity.ts';
import { SkillsRuntime } from './toolkit.ts';
import { fileURLToPath } from 'node:url';
import { runGatewayCommand, runOrchestrationCommand } from './cli/upgrade.ts';

async function main(args: string[]): Promise<void> {
  const parsed = parseGlobalOptions(args);
  Object.assign(output, parsed.options);
  args = parsed.args;
  const configPath = parsed.configPath;
  const help = requestedHelp(args);
  if (help) { await printHelp(help); return; }
  if (args.length === 1 && (args[0] === '--version' || args[0] === 'version')) { await printResult(buildInfoFromArtifact(await new SkillsRuntime().validate())); return; }
  const [command, ...rest] = args;
  if (command === 'skills') { await runSkillsCommand(rest); return; }
  if (command === 'codex') { await runCodexCommand(rest, configPath); return; }
  if (command === 'flow') { await runFlowCommand(rest, configPath); return; }
  if (command === 'service') { await runServiceCommand(rest); return; }
  if (command === 'worker-process') {
    const result = await new SkillsRuntime().run('skills/multi-task-flow/scripts/viewer-worker-process.ts', [], { timeoutMs: 2_147_483_647 });
    process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.code ?? 1; return;
  }
  if (command === 'gateway') { await runGatewayCommand(rest, configPath); return; }
  if (command === 'orchestration') { await runOrchestrationCommand(rest, configPath); return; }
  if (command === 'release') { await runReleaseCommand(rest); return; }
  if (command === 'workflow') {
    if (rest[0] === 'verify') throw new Error('WORKFLOW_LEGACY_COMMAND_UNSUPPORTED: use local-verify for local validation only; follow the migrated engineering Skills for delivery gates');
    if (!rest.length) throw new Error('Usage: workflow skills PROJECT_SKILLS_DIR [USER_SKILLS_DIR] | local-verify MANIFEST_JSON_PATH');
    const result = await runProcess(process.execPath, ['--no-install', fileURLToPath(new URL('./workflow/cli.ts', import.meta.url)), ...rest]);
    await printCaptured(result.stdout, result.stderr, 'workflow');
    if (result.code !== 0) process.exitCode = result.code ?? 1;
    return;
  }
  if (command === 'recover-lock' && rest.length === 1) { await StateLock.recover((await loadConfig(configPath)).stateDir, rest[0]!); await printResult({ recovered: true }); return; }
  if (command === 'git-status' && rest.length === 1) { await printResult(await new GitAdapter(rest[0]!).inspect()); return; }
  if (command === 'worktree' && (rest.length === 3 || rest.length === 4)) {
    await printResult(await new GitAdapter(rest[0]!).createWorktree(rest[1]!, rest[2]!, rest[3])); return;
  }
  if (!['status', 'tasks', 'receipts', 'apply', 'run'].includes(command ?? '') || (command === 'apply' ? rest.length !== 2 : command === 'run' ? rest.length !== 3 : rest.length !== 0)) throw new Error('Invalid command; see help');
  const client = await LocalClient.open(configPath);
  const controller = new AbortController();
  const interrupt = () => { controller.abort(); process.exitCode = 130; };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    let resultValue: unknown;
    switch (command) {
      case 'status': resultValue = { mode: client.config.mode, stateDir: client.config.stateDir, tasks: Object.keys(client.ledger.snapshot().tasks).length }; break;
      case 'tasks': resultValue = client.ledger.snapshot(); break;
      case 'receipts': resultValue = client.ledger.history(); break;
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
          resultValue = finished;
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
        resultValue = await client.ledger.execute(`${operationId}.finish`, { type: 'run.finish', runId, status, detail });
        if (status !== 'succeeded') process.exitCode = controller.signal.aborted ? 130 : 1;
        break;
      }
      case 'apply': resultValue = await client.ledger.execute(rest[0]!, JSON.parse(rest[1]!) as Operation); break;
    }
    await printResult(resultValue);
  } finally {
    await client.close(); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
}
main(process.argv.slice(2)).catch(async error => {
  process.exitCode = 1;
  if (error instanceof GlobalOptionsError) output.style = error.style;
  await printResult({ code: 'CLI_ERROR', error: error instanceof Error ? error.message : String(error) }, 'stderr').catch(() => {});
});
