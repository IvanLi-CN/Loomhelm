/** New convenience requests are compiled to the existing runtime contract. */
export function queryInput(args: string[]): Record<string, unknown> | undefined {
  const command = args[0];
  if (!['show', 'view'].includes(command ?? '') || args[1] === '--input') return undefined;
  const allowed = new Set(['--run-id', '--actor-role', '--thread-id', ...(command === 'show' ? ['--section', '--task-id'] : ['--plan-id'])]);
  const values = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    const [name, ...tail] = args[i]!.split('=');
    if (!allowed.has(name!)) throw new Error(`Invalid query option: ${name}`);
    if (values.has(name!)) throw new Error(`Repeated query option: ${name}`);
    const value = tail.length ? tail.join('=') : args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    values.set(name!, value);
  }
  for (const name of ['--run-id', '--actor-role', '--thread-id']) if (!values.has(name)) throw new Error(`Query requires ${name}`);
  const role = values.get('--actor-role')!;
  if (!['main', 'group', 'task'].includes(role)) throw new Error('Invalid --actor-role; use main|group|task');
  const input: Record<string, unknown> = { run_id: values.get('--run-id'), actor: { role, thread_id: values.get('--thread-id') } };
  if (command === 'show') {
    const section = values.get('--section') ?? 'summary';
    if (!['summary', 'plan', 'tasks', 'operations', 'notifications', 'task-context', 'full'].includes(section)) throw new Error('Invalid --section');
    if (section === 'task-context' && !values.has('--task-id')) throw new Error('task-context requires --task-id');
    input.section = section;
    if (values.has('--task-id')) input.task_id = values.get('--task-id');
  } else if (values.has('--plan-id')) input.plan_id = values.get('--plan-id');
  return input;
}
