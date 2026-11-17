import { test, expect, afterEach } from 'bun:test';
import { JsonStream, type JsonEvent } from '../src/cli/json-stream.ts';
import { GlobalOptionsError, parseGlobalOptions, resolveOutput, useColor, output } from '../src/cli/output-options.ts';
import { HumanJsonStream, recovery } from '../src/cli/output.ts';
import { queryInput } from '../src/cli/query-options.ts';
import { helpDocument, requestedHelp } from '../src/cli/help.ts';
import { FLOW_CONTRACT } from '../src/cli/flow-contract.ts';
import { runProcess } from '../src/runtime/process.ts';
import { resolve } from 'node:path';

afterEach(() => Object.assign(output, { style: 'json', verbose: false, color: 'auto' }));
test('auto detection is presentation only and explicit auto overrides the environment', () => {
  expect(resolveOutput(undefined, {}, true)).toBe('human');
  for (const env of [{ CI: 'true' }, { CONTINUOUS_INTEGRATION: '1' }, { CODEX_THREAD_ID: 'thread' }, { MULTI_TASK_FLOW_AGENT: '1' }]) expect(resolveOutput(undefined, env, true)).toBe('json');
  for (const CI of ['false', '0', ' FALSE ', '']) expect(resolveOutput(undefined, { CI }, true)).toBe('human');
  expect(resolveOutput('auto', { MULTI_TASK_FLOW_OUTPUT: 'json' }, true)).toBe('human');
  expect(resolveOutput('human', { CI: '1' }, false)).toBe('human');
  expect(resolveOutput(undefined, {}, false)).toBe('json');
  expect(() => resolveOutput('bad', {}, true)).toThrow();
});
test('global options preserve encoded positionals and raw script arguments', () => {
  const encoded = '{"prompt":"--output human"}';
  const parsed = parseGlobalOptions(['flow', 'show', '--output=human', '--verbose', '--config', '/tmp/config', encoded], {}, false);
  expect(parsed.args).toEqual(['flow', 'show', encoded]); expect(parsed.options.style).toBe('human'); expect(parsed.configPath).toBe('/tmp/config');
  expect(parseGlobalOptions(['skills', 'run', 'tool.ts', '--output', 'child'], {}, false).args).toEqual(['skills', 'run', 'tool.ts', '--output', 'child']);
  expect(parseGlobalOptions(['flow', 'show', '--', '--output', 'child'], {}, false).args).toEqual(['flow', 'show', '--', '--output', 'child']);
  for (const args of [['--output'], ['--output=x'], ['--output', 'json', '--output', 'human'], ['--verbose=yes'], ['--color', 'x']]) expect(() => parseGlobalOptions(args, {}, false)).toThrow();
});
test('color selection is independent and json never has ANSI', () => {
  Object.assign(output, { style: 'human', color: 'auto' });
  expect(useColor(true, {})).toBe(true); expect(useColor(true, { NO_COLOR: '' })).toBe(false); expect(useColor(true, { TERM: 'dumb' })).toBe(false);
  output.color = 'always'; expect(useColor(false, { NO_COLOR: '1' })).toBe(true);
  output.style = 'json'; expect(useColor(true, {})).toBe(false);
});
function parse(json: string, width: number): JsonEvent[] {
  const events: JsonEvent[] = [], parser = new JsonStream(event => events.push(event));
  const bytes = Buffer.from(json);
  for (let i = 0; i < bytes.length; i += width) parser.write(bytes.subarray(i, i + width));
  parser.finish(); return events;
}
test('incremental parser agrees across UTF-8, escaped strings, numbers and nesting splits', () => {
  const value = { ok: true, code: 'OK', result: [{ text: '中文🐈\n"\\', n: -12.3e-6, empty: [], other: null }, false], revision: 3 };
  const json = JSON.stringify(value);
  const expected = parse(json, 65536);
  for (let width = 1; width < 50; width++) expect(parse(json, width)).toEqual(expected);
  expect(parse('"\\u4e2d\\u6587"', 1)[0]?.value).toBe('中文');
});
test('parser rejects invalid output instead of accepting a partial result', () => {
  for (const text of ['', '{', '[1,]', '{"a":}', '{"a":1,}', '01', '--1', '-.2', '1.', '1e', 'true false', '"bad\n"', '"\\x"', '"\\uZZZZ"', '{"a" 1}', 'falsex', '[1 2]']) expect(() => parse(text, 1)).toThrow();
  expect(() => { const p = new JsonStream(() => {}); p.write(new Uint8Array([0xff])); }).toThrow();
});
test('parser buffer is bounded for large arrays and scalar tokens', () => {
  const p = new JsonStream(() => {}, 160);
  p.write(Buffer.from('["'));
  for (let i = 0; i < 200; i++) { p.write(Buffer.from('x'.repeat(65536))); expect(p.bufferedCharacters).toBeLessThanOrEqual(160); }
  p.write(Buffer.from('",'));
  for (let i = 0; i < 20000; i++) p.write(Buffer.from('123,'));
  p.write(Buffer.from('null]')); p.finish();
});
test('summary separates unknown and quiescence, limits lists and redacts secrets', async () => {
  output.style = 'human';
  const lines: string[] = [];
  const stream = new HumanJsonStream('flow show', async (channel, text) => { lines.push(channel + ':' + text); });
  await stream.write(Buffer.from(JSON.stringify({ ok: true, code: 'UNKNOWN', revision: 3, invocation: { state: 'running', quiescent: false, missing_evidence: ['receipt'] }, result: { tasks: Array.from({ length: 25 }, (_, i) => ({ task_id: `task-${i}`, status: 'blocked' })), token: 'DO-NOT-SHOW', nested: { password: 'ALSO-SECRET' } } })));
  await stream.finish(); const text = lines.join('');
  expect(text).toContain('未确认'); expect(text).toContain('已静止：否'); expect(text).toContain('省略 5 项'); expect(text).not.toContain('DO-NOT-SHOW'); expect(text).not.toContain('ALSO-SECRET');
  expect(recovery('REVISION_CONFLICT')).toContain('先重新读取');
});
test('error goes to stderr and parser failure never prints completion', async () => {
  output.style = 'human'; const lines: string[] = [];
  const s = new HumanJsonStream('flow show', async (channel, text) => { lines.push(`${channel}:${text}`); });
  await s.write(Buffer.from('{"ok":false,"code":"ACTOR_MISMATCH","message":"wrong actor"}')); await s.finish();
  expect(lines.every(line => line.startsWith('stderr:'))).toBe(true);
  const partial: string[] = [], broken = new HumanJsonStream('flow show', async (_, text) => { partial.push(text); });
  await broken.write(Buffer.from('{"ok":true,"revision":3,'));
  await expect(broken.finish()).rejects.toThrow(); expect(partial.join('')).not.toContain('接收完成');
});
test('sink is awaited and a broken pipe propagates without emitting a second result', async () => {
  output.style = 'human'; let release!: () => void; let reached = false;
  const s = new HumanJsonStream('flow show', async () => { reached = true; await new Promise<void>(r => { release = r; }); });
  let settled = false; const pending = s.write(Buffer.from('{"ok":true}')).then(() => { settled = true; });
  await new Promise(r => setTimeout(r, 10)); expect(reached).toBe(true); expect(settled).toBe(false); release(); await pending;
  const broken = new HumanJsonStream('flow show', async () => { throw Object.assign(new Error('closed'), { code: 'EPIPE' }); });
  await expect(broken.write(Buffer.from('{"ok":true}'))).rejects.toThrow('closed');
});
test('query shorthand requires explicit identity and cannot mix with stdin', () => {
  const args = ['show', '--run-id', 'demo', '--actor-role', 'main', '--thread-id', 'thread'];
  expect(queryInput(args)).toEqual({ run_id: 'demo', actor: { role: 'main', thread_id: 'thread' }, section: 'summary' });
  expect(queryInput(['show', '--input', '-'])).toBeUndefined();
  for (const extra of [['--input', '-'], ['--run-id', 'other'], ['--plan-id', 'x'], ['--section', 'task-context']]) expect(() => queryInput([...args, ...extra])).toThrow();
  expect(() => queryInput(['view', '--run-id', 'demo'])).toThrow('--actor-role');
});
test('all public flow help paths are discoverable without runtime access', () => {
  const names = helpDocument(['flow']).subcommands;
  for (const [name, meta] of Object.entries(FLOW_CONTRACT.commands)) {
    if (meta.access === 'internal') { expect(names).not.toContain(name); continue; }
    expect(helpDocument(['flow', name]).command).toBe(`multi-task-flow flow ${name}`);
  }
  expect(requestedHelp(['flow', 'show', '--run-id', 'demo', '--help'])).toEqual(['flow', 'show']);
  expect(requestedHelp(['skills', 'run', 'tool.ts', '--help'])).toBeUndefined();
  expect(() => helpDocument(['flow', 'not-a-command'])).toThrow();
});
test('real CLI help and argument failures do not require artifact or state', async () => {
  const cli = resolve('src/cli.ts');
  for (const args of [['--help'], ['service', '--help'], ['flow', 'show', '--help'], ['flow', 'help', 'show']]) {
    const r = await runProcess(process.execPath, [cli, '--output', 'json', ...args]);
    expect(r.code).toBe(0); expect(JSON.parse(r.stdout).schema_version).toBe(1); expect(r.stderr).toBe('');
  }
  const human = await runProcess(process.execPath, [cli, '--output', 'human', 'service', '--help']); expect(human.stdout).toContain('用法：');
  const failure = await runProcess(process.execPath, [cli, '--output', 'json', '--color=invalid', 'service', 'ensure']);
  expect(failure.code).toBe(1); expect(failure.stdout).toBe(''); expect(JSON.parse(failure.stderr).code).toBe('CLI_ERROR');
});

test('global parse errors retain explicit selectors before and after other invalid options', () => {
  for (const tty of [true, false]) {
    for (const args of [['--output', 'json', '--color=invalid'], ['--color=invalid', '--output=json'], ['--config', '--output=json']]) {
      try { parseGlobalOptions(args, { MULTI_TASK_FLOW_OUTPUT: 'human' }, tty); throw new Error('expected parse failure'); }
      catch (error) { expect(error).toBeInstanceOf(GlobalOptionsError); expect((error as GlobalOptionsError).style).toBe('json'); }
    }
  }
  expect(parseGlobalOptions(['--output=json'], { MULTI_TASK_FLOW_OUTPUT: 'invalid' }, true).options.style).toBe('json');
  try { parseGlobalOptions(['--color=invalid', '--output=human'], {}, false); }
  catch (error) { expect((error as GlobalOptionsError).style).toBe('human'); }
});
test('deep JSON retains linear state and bounded human output batches', async () => {
  const depth = 4096;
  let events = 0, pathElements = 0, omitted = false;
  const parser = new JsonStream(event => { events++; pathElements += event.path.length; omitted ||= !!event.depthOmitted; expect(event.path.length).toBeLessThanOrEqual(64); });
  parser.write(Buffer.from('['.repeat(depth)));
  expect(parser.bufferedStateSize).toBe(depth);
  parser.write(Buffer.from(']'.repeat(depth))); parser.finish();
  expect(parser.bufferedStateSize).toBe(0); expect(events).toBe(65); expect(pathElements).toBe(2080); expect(omitted).toBe(true);
  output.style = 'human'; let largest = 0, completed = false; omitted = false;
  const human = new HumanJsonStream('flow show', async (_, text) => {
    largest = Math.max(largest, Buffer.byteLength(text)); completed ||= text.includes('结果接收完成'); omitted ||= text.includes('深层内容已省略');
  });
  await human.write(Buffer.from('['.repeat(depth) + ']'.repeat(depth))); await human.finish();
  expect(largest).toBeLessThan(256 * 1024); expect(completed).toBe(true); expect(omitted).toBe(true);
});
test('human diagnostic values redact credentials even outside sensitive field names', async () => {
  output.style = 'human';
  const samples = ['Remote service rejected token ZX9-HIDDEN-VALUE', 'api key ZX9-HIDDEN-VALUE', 'password ZX9-HIDDEN-VALUE', 'refresh_token ZX9-HIDDEN-VALUE', 'access-token=ZX9-HIDDEN-VALUE', 'authorization: Bearer ZX9-HIDDEN-VALUE', 'Bearer ZX9-HIDDEN-VALUE', 'password=ZX9-HIDDEN-VALUE', '{"token":"ZX9-HIDDEN-VALUE"}', 'https://example.test/?ticket=ZX9-HIDDEN-VALUE', 'https://user:ZX9-HIDDEN-VALUE@example.test/'];
  for (const message of samples) {
    const lines: string[] = [];
    const stream = new HumanJsonStream('flow show', async (_, text) => { lines.push(text); });
    await stream.write(Buffer.from(JSON.stringify({ ok: false, code: 'AUTH_TOKEN_EXPIRED', message }))); await stream.finish();
    expect(lines.join('')).not.toContain('ZX9-HIDDEN-VALUE'); expect(lines.join('')).toContain('AUTH_TOKEN_EXPIRED');
  }
  const modulePath = resolve('src/cli/output.ts');
  const probe = await runProcess(process.execPath, ['-e', `import { printDiagnostics, output } from ${JSON.stringify(modulePath)}; output.style='human'; await printDiagnostics(${JSON.stringify(samples.join('\n'))});`]);
  expect(probe.code).toBe(0); expect(probe.stderr).not.toContain('ZX9-HIDDEN-VALUE'); expect(probe.stderr).toContain('敏感诊断已隐藏');
});

test('extremely deep projection work stays bounded and yields even with no displayed fields', async () => {
  output.style = 'human';
  const depth = 100_000;
  let events = 0, pathElements = 0;
  const parser = new JsonStream(event => { events++; pathElements += event.path.length; });
  parser.write(Buffer.from('['.repeat(depth) + '0' + ']'.repeat(depth))); parser.finish();
  expect(events).toBe(65); expect(pathElements).toBe(2080);
  let yielded = false;
  setImmediate(() => { yielded = true; });
  const human = new HumanJsonStream('flow show', async () => {});
  await human.write(Buffer.from('['.repeat(depth)));
  expect(yielded).toBe(true);
  await human.write(Buffer.from('0' + ']'.repeat(depth))); await human.finish();
  const invalid = new HumanJsonStream('flow show', async () => {});
  await expect(invalid.write(Buffer.from('['.repeat(depth) + 'invalid'))).rejects.toThrow();
});

test('human error routing is independent of envelope field order and decision buffering is bounded', async () => {
  output.style = 'human';
  const lines: { channel: string; text: string }[] = [];
  const human = new HumanJsonStream('flow show', async (channel, text) => { lines.push({ channel, text }); });
  await human.write(Buffer.from('{"message":"denied",'));
  expect(lines).toHaveLength(0);
  await human.write(Buffer.from('"ok":false,"code":"ACTOR_MISMATCH"}')); await human.finish();
  expect(lines.length).toBeGreaterThan(0); expect(lines.every(line => line.channel === 'stderr')).toBe(true);
  const overflow: string[] = [];
  const deep = new HumanJsonStream('flow show', async (channel) => { overflow.push(channel); });
  await deep.write(Buffer.from('{' + Array.from({ length: 600 }, (_, i) => JSON.stringify(`field${i}`) + ':' + JSON.stringify('x'.repeat(160))).join(',') + ','));
  expect(overflow.length).toBeGreaterThan(0); expect(overflow.every(channel => channel === 'stderr')).toBe(true);
  await deep.write(Buffer.from('"ok":false}')); await deep.finish();
  expect(overflow.every(channel => channel === 'stderr')).toBe(true);
});
test('unknown records without envelope code still give reconciliation guidance', async () => {
  output.style = 'human'; const lines: string[] = [];
  const human = new HumanJsonStream('codex dispatch', async (_, text) => { lines.push(text); });
  await human.write(Buffer.from('{"operationId":"dispatch-example","state":"unknown"}')); await human.finish();
  expect(lines.join('')).toContain('命令返回未确认结果'); expect(lines.join('')).toContain('reconcile');
  const success: string[] = [];
  const plain = new HumanJsonStream('service status', async (channel, text) => { success.push(channel + ':' + text); });
  await plain.write(Buffer.from('{"installed":false}')); await plain.finish();
  expect(success.every(line => line.startsWith('stdout:'))).toBe(true);
});
