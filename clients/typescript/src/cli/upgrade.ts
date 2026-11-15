import { SkillsRuntime } from '../toolkit.ts';

async function invoke(command: string, input: unknown): Promise<void> {
  const result = await new SkillsRuntime().run('skills/multi-task-flow/scripts/service.ts', [command, '--input', '-'], { input: JSON.stringify(input) });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if ((result.code ?? 1) !== 0) process.exitCode = result.code ?? 1;
}

function target(args: string[], start: number): { value: string; mode: 'normal' | 'dry-run' | 'rollback' } {
  let mode: 'normal' | 'dry-run' | 'rollback' = 'normal';
  let value: string | undefined;
  for (let index = start; index < args.length; index += 1) {
    const item = args[index]!;
    if (item === '--dry-run' || item === '--rollback') {
      if (mode !== 'normal') throw new Error('UPGRADE_INVALID_ARGUMENTS: --dry-run and --rollback are mutually exclusive');
      mode = item === '--dry-run' ? 'dry-run' : 'rollback';
      continue;
    }
    if (value !== undefined) throw new Error('UPGRADE_INVALID_ARGUMENTS: exactly one version or tag is required');
    value = item;
  }
  if (!value) throw new Error('UPGRADE_INVALID_ARGUMENTS: a version or tag is required');
  return { value, mode };
}

export async function runGatewayCommand(args: string[]): Promise<void> {
  if (args[0] !== 'upgrade') throw new Error('GATEWAY_INVALID_ARGUMENTS: use gateway upgrade [--dry-run|--rollback] <version|tag>');
  const selected = target(args, 1);
  await invoke('gateway-upgrade', { target: selected.value, mode: selected.mode });
}

export async function runOrchestrationCommand(args: string[]): Promise<void> {
  if (args[0] !== 'upgrade') throw new Error('ORCHESTRATION_INVALID_ARGUMENTS: use orchestration upgrade --run-id <run-id> [--dry-run|--rollback] <version|tag>');
  const runIndex = args.indexOf('--run-id');
  if (runIndex < 0 || !args[runIndex + 1]) throw new Error('ORCHESTRATION_INVALID_ARGUMENTS: --run-id is required');
  const runId = args[runIndex + 1]!;
  const remaining = args.slice(1).filter((_, index) => index !== runIndex - 1 && index !== runIndex);
  const selected = target(remaining, 0);
  await invoke('orchestration-upgrade', { run_id: runId, target: selected.value, mode: selected.mode });
}
