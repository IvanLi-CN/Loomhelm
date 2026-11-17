import { printCaptured } from './output.ts';
import { SkillsRuntime } from '../toolkit.ts';

export async function runServiceCommand(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === 'daemon') {
    // A daemon has no bounded command lifetime; the launchd job owns its lifecycle.
    const result = await new SkillsRuntime().run('skills/multi-task-flow/scripts/service.ts', ['daemon'], {
      timeoutMs: 2_147_483_647,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code ?? 1;
    return;
  }
  if (args[0] === 'help' || !args.length) {
    console.log('service COMMAND --input -');
    return;
  }
  const convenience = args.length === 1 && ['status', 'doctor'].includes(args[0]!);
  if (!convenience && (args.length !== 3 || args[1] !== '--input' || args[2] !== '-')) {
    throw new Error('SERVICE_INVALID_ARGUMENTS: use COMMAND --input - with one JSON object on stdin');
  }
  if (!convenience && process.stdin.isTTY) throw new Error('Service requires a JSON request on stdin');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of (convenience ? [] : process.stdin)) {
    const data = Buffer.from(chunk);
    size += data.length;
    if (size > 256 * 1024 * 1024) throw new Error('Service input too large');
    chunks.push(data);
  }
  const result = await new SkillsRuntime().run('skills/multi-task-flow/scripts/service.ts', [args[0]!, '--input', '-'], {
    input: convenience ? '{}' : Buffer.concat(chunks),
  });
  await printCaptured(result.stdout, result.stderr, `service ${args[0]}`);
  process.exitCode = result.code ?? 1;
}
