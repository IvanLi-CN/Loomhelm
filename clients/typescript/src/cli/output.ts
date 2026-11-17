import type { Writable } from 'node:stream';
import { JsonStream, type JsonEvent, type JsonPath } from './json-stream.ts';
import { output, useColor } from './output-options.ts';
export { output } from './output-options.ts';
export type Sink = (stream: 'stdout' | 'stderr', text: string) => Promise<void>;
export async function writeOutput(stream: 'stdout' | 'stderr', text: string): Promise<void> {
  const target: Writable = process[stream];
  // A write callback can reject before Writable emits its error event.
  const ignore = () => {};
  target.on('error', ignore);
  try {
    const bytes = Buffer.from(text);
    for (let at = 0; at < bytes.length; at += 64 * 1024)
      await new Promise<void>((resolve, reject) => target.write(bytes.subarray(at, at + 64 * 1024), error => error ? reject(error) : resolve()));
  } finally { await new Promise<void>(resolve => setImmediate(resolve)); target.off('error', ignore); }
}
const clean = (value: unknown) => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const labels: Record<string, string> = { code: '结果码', revision: '版本', status: '状态', state: '状态', run_id: '运行', thread_id: '对话', task_id: '任务', group_id: '交付单元', operation_id: '操作', message: '原因', error: '错误', installed: '已安装', running: '运行中', quiescent: '已静止', missing_evidence: '缺失证据', warning: '警告', mode: '模式', tasks: '任务', root: '数据目录', source_sha: '源码 SHA', version: '版本', url: '链接' };
const secret = /credential|token|secret|password|authorization|cookie|prompt|ticket|api[ _-]?key|oversized-key/i;
// Opaque diagnostic values are not safe just because their field is named message.
const credentialText = /(?:authorization|cookies?|credentials?|passwords?|secrets?|(?:access[ _-]?)?tokens?|api[ _-]?keys?|tickets?)\b|\b(?:Bearer|Basic)\s+\S+|https?:\/\/[^/\s]+:[^/\s]+@/i;
const safeText = (value: unknown, loginUrl = false) => !loginUrl && credentialText.test(String(value)) ? '[敏感诊断已隐藏]' : clean(value);
const important = /^(ok|code|revision|status|state|.*_id|.*Id|id|name|title|message|error|detail|reason|blocked.*|blocking.*|.*count|installed|running|root|mode|version|.*sha|.*digest|quiescent|missing_evidence|warning|should_send|next_action|url|login_url)$/;
export function recovery(code: string): string | undefined {
  if (/REVISION_CONFLICT/.test(code)) return '先重新读取当前 revision，再决定下一步；不要盲目重放写入。';
  if (/PENDING|UNKNOWN|RECONCILIATION|CREATION/.test(code)) return '结果尚未确认，先检查对应 operation 并执行适用的 reconcile；不要重复副作用。';
  if (/ACTOR|FORBIDDEN|PERMISSION/.test(code)) return '核对 --actor-role、--thread-id 与运行绑定。';
  if (/VERSION|BINDING/.test(code)) return '检查运行绑定并使用匹配的精确 CLI 版本。';
  if (/OUTPUT|UTF/.test(code)) return '输出交付未完成；先核验原操作结果及停止证据，不要重新执行业务。';
  return undefined;
}

/** A bounded projection; no retained array items or complete response object. */
export class HumanProjection {
  private lines: string[] = [];
  private failed = false;
  private code = '';
  private started = false;
  private depthOmitted = false;
  constructor(private command: string, private sink: Sink = writeOutput, private forced?: 'stderr') {}
  consume(event: JsonEvent): void {
    const { path, value } = event;
    if (event.depthOmitted) this.depthOmitted = true;
    const key = String(path.at(-1) ?? 'result');
    if (path.length === 1 && key === 'ok' && value === false) this.failed = true;
    if (path.length === 1 && key === 'code') this.code = String(value);
    if (path.length === 1 && key === 'error') this.failed = true;
    if (path.some(part => typeof part === 'string' && secret.test(part))) return;
    if (!output.verbose && path.some(part => typeof part === 'number' && part >= 20)) return;
    if (event.kind !== 'scalar') {
      if (event.kind === 'array' && event.count !== undefined) {
        this.lines.push(`${this.pathLabel(path)}：${event.count} 项${!output.verbose && event.count > 20 ? `（省略 ${event.count - 20} 项，使用 --verbose 或 --output json）` : ''}`);
      }
      return;
    }
    if (!output.verbose && !important.test(key) && path.length > 2 && !path.includes('missing_evidence')) return;
    if ((key === 'url' || key === 'login_url') && this.command !== 'service login') return;
    const cap = output.verbose ? 4096 : 160;
    const status = typeof value === 'string' && ['state', 'status'].includes(key) ? ({ unknown: '未确认', blocked: '阻塞', running: '运行中', stopped: '已停止', failed: '失败', succeeded: '成功' } as Record<string, string>)[value] ?? value : value;
    const text = key === 'code' && typeof status === 'string' && /^[A-Z][A-Z0-9_]{0,159}$/.test(status) ? status : safeText(status === true ? '是' : status === false ? '否' : status === null ? '无' : status, this.command === 'service login' && ['url', 'login_url'].includes(key));
    const suffix = event.truncated || text.length > cap ? '…（已省略，完整内容见 --output json）' : '';
    this.lines.push(`${this.pathLabel(path)}：${text.slice(0, cap)}${suffix}`);
  }
  private pathLabel(path: JsonPath): string {
    const tail = path.slice(-6).filter(p => p !== 'result');
    const label = tail.map(p => typeof p === 'number' ? `[${p + 1}]` : (labels[p] ?? safeText(p).slice(0, 80))).join(' · ');
    return `${path.length > 6 ? '… · ' : ''}${label}`.slice(-160) || '结果';
  }
  async flush(): Promise<void> {
    if (!this.lines.length) return;
    const stream = this.forced ?? (this.failed ? 'stderr' : 'stdout');
    let text = '';
    if (!this.started) { text = `${this.command} · 接收中，结果未完成\n`; this.started = true; }
    text += this.lines.join('\n') + '\n'; this.lines = [];
    await this.sink(stream, text);
  }
  async finish(): Promise<void> {
    await this.flush();
    const stream = this.forced ?? (this.failed ? 'stderr' : 'stdout');
    const next = recovery(this.code);
    if (this.depthOmitted) await this.sink(stream, '深层内容已省略（超过 64 层），完整结果使用 --output json。\n');
    const line = this.failed ? '命令返回错误' : this.code === 'UNKNOWN' ? '命令返回未确认结果' : '结果接收完成（不代表调用已静止）';
    const color = useColor(!!process[stream].isTTY);
    await this.sink(stream, `${color ? '\x1b[36m' : ''}${line}${color ? '\x1b[0m' : ''}\n${next ? `下一步：${next}\n` : ''}`);
  }
}
export class HumanJsonStream {
  private projection: HumanProjection;
  private parser: JsonStream;
  constructor(command: string, sink: Sink = writeOutput, forced?: 'stderr') {
    this.projection = new HumanProjection(command, sink, forced);
    this.parser = new JsonStream(event => this.projection.consume(event));
  }
  async write(bytes: Uint8Array): Promise<void> {
    // Bound queued display lines even when an upstream caller supplies a huge chunk.
    for (let offset = 0; offset < bytes.length; offset += 1024) {
      this.parser.write(bytes.subarray(offset, offset + 1024)); await this.projection.flush();
      // Yield to signals and the independent stop path even if no fields were displayed.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  async finish(): Promise<void> { this.parser.finish(); await this.projection.finish(); }
}
export async function printResult(value: unknown, stream: 'stdout' | 'stderr' = 'stdout', command = 'multi-task-flow'): Promise<void> {
  if (output.style === 'json') { await writeOutput(stream, JSON.stringify(value) + '\n'); return; }
  const projection = new HumanProjection(command, writeOutput, stream === 'stderr' ? 'stderr' : undefined);
  let count = 0;
  async function visit(item: unknown, path: JsonPath): Promise<void> {
    if (path.length > 64) { projection.consume({ kind: 'object', path: [], depthOmitted: true }); return; }
    if (item !== null && typeof item === 'object') {
      let index = 0;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        const child = (item as Record<string, unknown>)[key];
        if (output.verbose || !Array.isArray(item) || index < 20) await visit(child, [...path, Array.isArray(item) ? index : key]);
        index++;
      }
      projection.consume({ kind: Array.isArray(item) ? 'array' : 'object', path, count: index });
    } else projection.consume({ kind: 'scalar', path, value: item as string | number | boolean | null });
    if (++count % 128 === 0) await projection.flush();
  }
  await visit(value, []); await projection.finish();
}
export async function printCaptured(stdout: string, stderr: string, command: string): Promise<void> {
  if (output.style === 'json') { if (stdout) await writeOutput('stdout', stdout); if (stderr) await writeOutput('stderr', stderr); return; }
  if (stdout.trim()) { const stream = new HumanJsonStream(command); await stream.write(Buffer.from(stdout)); await stream.finish(); }
  if (stderr) await printDiagnostics(stderr);
}
export async function printDiagnostics(text: string): Promise<void> {
  for (const line of text.split('\n').filter(Boolean)) {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { await writeOutput('stderr', `诊断：${safeText(line).slice(0, 4096)}\n`); continue; }
    await printResult(value, 'stderr');
  }
}
