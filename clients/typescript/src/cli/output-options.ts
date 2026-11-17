export type OutputStyle = 'human' | 'json';
export interface OutputOptions { style: OutputStyle; verbose: boolean; color: 'auto' | 'always' | 'never' }
export const output: OutputOptions = { style: 'json', verbose: false, color: 'auto' };
const truthy = (value: string | undefined) => !!value?.trim() && !/^(0|false)$/i.test(value.trim());

export function resolveOutput(value: string | undefined, env: NodeJS.ProcessEnv, tty: boolean): OutputStyle {
  const selected = value ?? env.MULTI_TASK_FLOW_OUTPUT ?? 'auto';
  if (!['auto', 'human', 'json'].includes(selected)) throw new Error('Invalid --output; use auto|human|json');
  if (selected !== 'auto') return selected as OutputStyle;
  return !tty || !!env.CODEX_THREAD_ID?.trim() || env.MULTI_TASK_FLOW_AGENT === '1' || truthy(env.CI) || truthy(env.CONTINUOUS_INTEGRATION) ? 'json' : 'human';
}

/** Consume only whole global option tokens; never inspect encoded positional JSON. */
export function parseGlobalOptions(argv: string[], env = process.env, tty = !!process.stdout.isTTY): { args: string[]; options: OutputOptions; configPath?: string } {
  const args: string[] = [];
  const seen = new Set<string>();
  let style: string | undefined, configPath: string | undefined;
  let verbose = false, color: OutputOptions['color'] = 'auto';
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') { args.push(...argv.slice(i)); break; }
    // skills run owns its script arguments, even for legacy callers without --.
    if (args[0] === 'skills' && args[1] === 'run' && args.length >= 3) { args.push(...argv.slice(i)); break; }
    const [name, ...tail] = token.split('=');
    if (!['--output', '--verbose', '--color', '--config'].includes(name!)) { args.push(token); continue; }
    if (seen.has(name!)) throw new Error(`Repeated global option: ${name}`);
    seen.add(name!);
    if (name === '--verbose') {
      if (tail.length) throw new Error('--verbose accepts no value');
      verbose = true; continue;
    }
    const value = tail.length ? tail.join('=') : argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    if (name === '--output') style = value;
    else if (name === '--config') configPath = value;
    else {
      if (!['auto', 'always', 'never'].includes(value)) throw new Error('Invalid --color; use auto|always|never');
      color = value as OutputOptions['color'];
    }
  }
  return { args, options: { style: resolveOutput(style, env, tty), verbose, color }, ...(configPath === undefined ? {} : { configPath }) };
}

export function useColor(tty: boolean, env = process.env): boolean {
  return output.style === 'human' && (output.color === 'always' || (output.color === 'auto' && tty && env.NO_COLOR === undefined && env.TERM !== 'dumb'));
}
