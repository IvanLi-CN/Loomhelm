import { FLOW_CONTRACT } from './flow-contract.ts';
import { output, writeOutput } from './output.ts';
interface Help { schema_version: 1; command: string; summary: string; usage: string; options: string[]; examples: string[]; subcommands: string[] }
const groups: Record<string, string[]> = {
  flow: [...Object.keys(FLOW_CONTRACT.commands).filter(name => FLOW_CONTRACT.commands[name]!.access !== 'internal'), 'schema'],
  service: ['status', 'doctor', 'login', 'ensure', 'renew', 'release', 'install', 'upgrade', 'rollback', 'import', 'migrate', 'compatibility-check', 'ledger-maintenance-check', 'ledger-maintenance-apply', 'credential-rotate', 'credential-revoke', 'reader-check', 'read-only-view', 'gateway-upgrade', 'orchestration-compatibility-check', 'orchestration-upgrade-check', 'orchestration-upgrade', 'daemon'],
  orchestration: ['schema', 'compatibility-check', 'upgrade-check', 'upgrade'],
  gateway: ['upgrade'], skills: ['list', 'check', 'run'], release: ['identity', 'validate'],
  codex: ['dispatch', 'list', 'reconcile', 'approve', 'retry'], workflow: ['skills', 'local-verify'],
};
const local = ['status', 'tasks', 'receipts', 'recover-lock', 'apply', 'run', 'git-status', 'worktree', 'version'];
const descriptions: Record<string, string> = { flow: '查询与编排运行', service: '检查及管理共享 viewer 服务', orchestration: '检查编排兼容性与前向升级', gateway: '管理网关版本', skills: '发现、校验和执行 Skill', release: '核验发布身份和参数', codex: '检查及管理原生调用', workflow: '本地工程验证', show: '读取运行的指定部分', view: '读取运行视图', status: '检查当前状态', doctor: '诊断服务状态', schema: '导出完整机器 Schema', login: '获取一次性浏览器登录入口', version: '显示构建身份', tasks: '读取本地任务账本', receipts: '读取操作回执' };
const positional: Record<string, string> = { 'recover-lock': 'TOKEN', apply: 'OPERATION_ID JSON', run: 'OPERATION_ID TASK_ID COMMAND_JSON', 'git-status': 'PATH', worktree: 'REPO ABS_PATH BRANCH [BASE]', 'skills check': 'NAME', 'skills run': 'SCRIPT [-- SCRIPT_ARGS...]', 'codex dispatch': 'REQUEST_ID JSON', 'codex reconcile': 'DISPATCH_ID', 'codex approve': 'DISPATCH_ID', 'codex retry': 'DISPATCH_ID [accept|decline|cancel]', 'workflow skills': 'PROJECT_SKILLS_DIR [USER_SKILLS_DIR]', 'workflow local-verify': 'MANIFEST_JSON_PATH', 'release validate': '--version VERSION [--dist-tag TAG] [--compatibility-line LINE] [--require-provenance]', 'gateway upgrade': '[--dry-run|--rollback] VERSION_OR_TAG' };
const globalOptions = ['--output auto|human|json（参数 > MULTI_TASK_FLOW_OUTPUT > 自动判断）', '--color auto|always|never（显式值优先于 NO_COLOR）', '--verbose（人类细节；完整字段使用 --output json）', '--config PATH', '-h, --help', '--（其后原样透传）'];

export function helpDocument(path: string[]): Help {
  const [group, sub] = path;
  if (path.length > 2 || (group && !groups[group] && !local.includes(group)) || (sub && !groups[group!]?.includes(sub))) throw new Error(`Unknown command: ${path.join(' ')}; use --help`);
  const name = path.join(' ');
  const command = `multi-task-flow${name ? ` ${name}` : ''}`;
  let suffix = positional[name] ?? '';
  let options = [...globalOptions];
  const examples: string[] = [];
  if (group === 'flow' && sub && sub !== 'schema') {
    const metadata = FLOW_CONTRACT.commands[sub]!;
    const request = metadata.request as { required?: string[]; properties?: Record<string, unknown> };
    suffix = '--input - [--socket PATH]';
    options.push(`JSON 请求必填：${request.required?.join(', ') ?? '见 Schema'}`, '写操作必须保留 request_id、expected_revision 和绑定 actor；不确定结果先对账');
    if (sub === 'show' || sub === 'view') {
      suffix = '--run-id RUN_ID --actor-role main|group|task --thread-id THREAD_ID';
      options.push(sub === 'show' ? '--section summary|plan|tasks|operations|notifications|task-context|full（默认 summary）；--task-id TASK_ID' : '--plan-id PLAN_ID');
      options.push('也可使用 --input -；不可与查询参数混用');
      examples.push(`${command} --output human --run-id RUN_ID --actor-role main --thread-id THREAD_ID`);
      examples.push(`printf '%s' '{"run_id":"RUN_ID","actor":{"role":"main","thread_id":"THREAD_ID"}}' | ${command} --output json --input -`);
    } else examples.push(`${command} --output json --input - < request.json`);
    options.push('请求与响应字段：multi-task-flow flow schema --format json');
  } else if (sub === 'schema') suffix = '--format json';
  else if (group === 'service' && sub) {
    suffix = ['status', 'doctor', 'daemon'].includes(sub) ? '' : '--input -';
    if (sub === 'daemon') options.push('raw：daemon 输出不受 --output 影响');
    if (suffix) examples.push(`${command} --output json --input - < request.json`);
  } else if (group === 'orchestration' && sub) suffix = sub === 'upgrade' ? '--run-id RUN_ID [--dry-run] VERSION_OR_TAG' : '--run-id RUN_ID';
  if (group === 'skills' && sub === 'run') options.push('raw：脚本输出与参数保持原样；脚本参数使用 -- 分隔');
  if (group === 'run') options.push('COMMAND_JSON 是命令参数数组；不会执行 shell 字符串');
  const children = !group ? [...Object.keys(groups), ...local] : sub ? [] : groups[group] ?? [];
  if (children.length) suffix = 'COMMAND [ARGS...]';
  if (!examples.length) examples.push(`${command}${suffix ? ` ${suffix}` : ''}`);
  return { schema_version: 1, command, summary: descriptions[sub ?? group ?? ''] ?? (sub ? `执行 ${sub}；权限与恢复要求沿用现有协议` : '项目任务编排与本地工程工具'), usage: `${command}${suffix ? ` ${suffix}` : ''}`, options, examples, subcommands: children };
}
export function requestedHelp(args: string[]): string[] | undefined {
  const boundary = args.indexOf('--');
  const own = boundary < 0 ? args : args.slice(0, boundary);
  // A script owns everything after its name, including --help.
  if (own[0] === 'skills' && own[1] === 'run' && own.length > 2 && !['--help', '-h', 'help'].includes(own[2]!)) return undefined;
  const index = own.findIndex(a => ['--help', '-h', 'help'].includes(a));
  if (index >= 0) return own[index] === 'help' ? [...own.slice(0, index), ...own.slice(index + 1)] : own.slice(0, Math.min(index, groups[own[0]!] ? 2 : 1));
  if (!own.length || (own.length === 1 && groups[own[0]!])) return own;
  return undefined;
}
export async function printHelp(path: string[]): Promise<void> {
  const doc = helpDocument(path);
  if (output.style === 'json') { await writeOutput('stdout', JSON.stringify(doc) + '\n'); return; }
  await writeOutput('stdout', `${doc.command}\n${doc.summary}\n\n用法：${doc.usage}\n\n全局与命令参数：\n${doc.options.map(x => `  ${x}`).join('\n')}\n${doc.subcommands.length ? `\n命令：\n${doc.subcommands.map(x => `  ${x}  ${descriptions[x] ?? ''}`).join('\n')}\n` : ''}\n示例：\n${doc.examples.map(x => `  ${x}`).join('\n')}\n`);
}
