import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
  if (args.includes('--help')) {
    console.log('orchestration schema --format json | orchestration compatibility-check --run-id RUN_ID | orchestration upgrade-check --run-id RUN_ID | orchestration upgrade --run-id RUN_ID [--dry-run] VERSION_OR_TAG\nUse the verified target CLI. Read-only checks create no locks. Migration readiness does not assert native quiescence; unresolved calls are preserved without retry. Upgrades migrate supported ledgers and switch binding forward only; incomplete upgrades resume their frozen target.');
    return;
  }
  if (args[0] === 'schema') {
    if (args.length !== 3 || args[1] !== '--format' || args[2] !== 'json') throw new Error('Usage: orchestration schema --format json');
    const domain = JSON.parse(await readFile(resolve(new SkillsRuntime().root, 'skills/multi-task-flow/lib/flow-domain-schemas.json'), 'utf8'));
    if (!domain.migration_report?.properties?.migration_ready) throw new Error('ORCHESTRATION_SCHEMA_UNAVAILABLE: packaged migration report schema is missing');
    console.log(JSON.stringify(domain.migration_report));
    return;
  }
  if (!['upgrade', 'compatibility-check', 'upgrade-check'].includes(args[0] ?? '')) throw new Error('ORCHESTRATION_INVALID_ARGUMENTS: use orchestration upgrade --run-id <run-id> [--dry-run] <version|tag> or orchestration compatibility-check --run-id <run-id>');
  const runIndex = args.indexOf('--run-id');
  if (runIndex < 0 || !args[runIndex + 1]) throw new Error('ORCHESTRATION_INVALID_ARGUMENTS: --run-id is required');
  const runId = args[runIndex + 1]!;
  const remaining = args.slice(1).filter((_, index) => index !== runIndex - 1 && index !== runIndex);
  if (args[0] === 'compatibility-check' || args[0] === 'upgrade-check') {
    if (remaining.length) throw new Error('ORCHESTRATION_INVALID_ARGUMENTS: checks only accept --run-id');
    return invoke(`orchestration-${args[0]}`, { run_id: runId });
  }
  const selected = target(remaining, 0);
  if (selected.mode === 'rollback') throw new Error('DOWNGRADE_FORBIDDEN: orchestration upgrades are forward-only');
  await invoke('orchestration-upgrade', { run_id: runId, target: selected.value, mode: selected.mode });
}
