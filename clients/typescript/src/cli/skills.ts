import { SkillsRuntime } from '../toolkit.js';

export async function runSkillsCommand(args: string[]): Promise<void> {
  const runtime = new SkillsRuntime();
  if (args[0] === 'list' && args.length === 1) { console.log(JSON.stringify(await runtime.list())); return; }
  if (args[0] === 'check' && args.length === 2) { const result = await runtime.check(args[1]!); console.log(JSON.stringify(result)); if (!result.ready) process.exitCode = 3; return; }
  if (args[0] === 'run' && args[1]) {
    // Preserve stdin and the original JSON/exit-code contract. Authorization for
    // specialty scripts remains a caller obligation, as documented by each Skill.
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of (process.stdin.isTTY ? [] : process.stdin)) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 16 * 1024 * 1024) throw new Error('Skill input too large');
      chunks.push(bytes);
    }
    const result = await runtime.run(args[1], args.slice(2), { input: Buffer.concat(chunks) });
    process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.code ?? 1; return;
  }
  throw new Error('Usage: skills list | check NAME | run SCRIPT [ARGS...]');
}
