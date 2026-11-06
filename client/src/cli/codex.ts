import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexAppServer, CodexRequestError, type ServerCall } from '../codex/index.js';
import { DispatchUncertainError, ThreadDispatcher, type DispatchAdapter, type DispatchInput, type DispatchRecord, type ReadThreadResult, type StartThreadRequest, type StartTurnRequest, type TurnResult } from '../dispatch/index.js';
import { atomicWrite } from '../runtime/files.js';
import { StateLock } from '../runtime/lock.js';
import { loadConfig } from '../config.js';

type ApprovalDecision = 'accept' | 'decline' | 'cancel';
interface CodexRequest extends DispatchInput {
  model?: string;
  effort?: string;
  timeoutMs?: number;
  approvalDecision?: ApprovalDecision;
}
interface CodexProfile extends Omit<CodexRequest, 'requestId' | 'approvalDecision'> { approvalDecision?: ApprovalDecision }
interface ProfileFile { schemaVersion: 1; requests: Record<string, CodexProfile> }
interface Completion { threadId: string; turn: { id?: string; status?: string; error?: { message?: string } | null } }
interface ActiveTurn { resolve(value: Completion | Error): void }
const decisions = new Set<ApprovalDecision>(['accept', 'decline', 'cancel']);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function parseRequest(value: unknown, requestId: string): CodexRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Dispatch request must be a JSON object');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !['title', 'prompt', 'cwd', 'model', 'effort', 'timeoutMs', 'approvalDecision'].includes(key))) throw new Error('Unknown dispatch request field');
  if (!text(item.title) || !text(item.prompt)) throw new Error('Dispatch requires nonempty title and prompt');
  if (item.cwd !== undefined && !text(item.cwd)) throw new Error('cwd must be a nonempty path');
  if (item.model !== undefined && !text(item.model)) throw new Error('model must be a nonempty string');
  if (item.effort !== undefined && !text(item.effort)) throw new Error('effort must be a nonempty string');
  if (item.timeoutMs !== undefined && (!Number.isSafeInteger(item.timeoutMs) || Number(item.timeoutMs) < 1 || Number(item.timeoutMs) > 1_800_000)) throw new Error('timeoutMs must be between 1 and 1800000');
  if (item.approvalDecision !== undefined && !decisions.has(item.approvalDecision as ApprovalDecision)) throw new Error('approvalDecision must be accept, decline or cancel');
  return { requestId, title: item.title, prompt: item.prompt, ...(item.cwd ? { cwd: item.cwd as string } : {}) ,
    ...(item.model ? { model: item.model as string } : {}), ...(item.effort ? { effort: item.effort as string } : {}),
    ...(item.timeoutMs ? { timeoutMs: item.timeoutMs as number } : {}), ...(item.approvalDecision ? { approvalDecision: item.approvalDecision as ApprovalDecision } : {}) };
}

async function saveProfile(directory: string, request: CodexRequest): Promise<void> {
  const path = join(directory, 'requests.json');
  const lock = await StateLock.acquire(directory);
  try {
    let file: ProfileFile = { schemaVersion: 1, requests: {} };
    try {
      file = JSON.parse(await readFile(path, 'utf8')) as ProfileFile;
      if (file.schemaVersion !== 1 || !file.requests || typeof file.requests !== 'object') throw new Error('Invalid Codex request profile store');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const profile: CodexProfile = { title: request.title, prompt: request.prompt, ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.model ? { model: request.model } : {}), ...(request.effort ? { effort: request.effort } : {}), ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
      ...(request.approvalDecision ? { approvalDecision: request.approvalDecision } : {}) };
    const old = file.requests[request.requestId];
    if (old && JSON.stringify({ ...old, approvalDecision: undefined }) !== JSON.stringify({ ...profile, approvalDecision: undefined })) throw new Error('Dispatch request identity conflicts with its persisted Codex profile');
    file.requests[request.requestId] = { ...old, ...profile };
    await atomicWrite(path, file);
  } finally { await lock.release(); }
}

async function readProfile(directory: string, requestId: string): Promise<CodexProfile> {
  const file = JSON.parse(await readFile(join(directory, 'requests.json'), 'utf8')) as ProfileFile;
  if (file.schemaVersion !== 1 || !file.requests?.[requestId]) throw new Error('Persisted Codex profile was not found for this request');
  return file.requests[requestId]!;
}

class AppServerDispatchAdapter implements DispatchAdapter {
  private readonly active = new Map<string, ActiveTurn>();
  private readonly profiles = new Map<string, CodexProfile>();
  private profileError: string | undefined;

  constructor(private readonly server: CodexAppServer, private readonly profile: CodexProfile, private readonly approvalDecision?: ApprovalDecision) {
    server.on('notification', notification => {
      if (notification.method !== 'turn/completed' || !notification.params || typeof notification.params !== 'object') return;
      const params = notification.params as Completion & { threadId?: unknown };
      if (typeof params.threadId === 'string') this.active.get(params.threadId)?.resolve(params);
    });
    server.on('serverRequest', call => { void this.handleServerRequest(call); });
  }

  private async handleServerRequest(call: ServerCall): Promise<void> {
    const params = call.params && typeof call.params === 'object' ? call.params as Record<string, unknown> : {};
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    if (!call.approval || !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(call.method)) {
      if (threadId) this.active.get(threadId)?.resolve(new Error(`Explicit caller decision required for Codex request ${call.method}`));
      process.stderr.write(`${JSON.stringify({ event: 'codex.request', method: call.method, approval: call.approval, params })}\n`);
      return;
    }
    const decision = this.approvalDecision ?? 'decline';
    try {
      await call.respond({ decision });
      if (!this.approvalDecision) process.stderr.write(`${JSON.stringify({ event: 'codex.approval', decision: 'decline', reason: 'No explicit caller approval decision was supplied', params })}\n`);
    }
    catch (error) { if (threadId) this.active.get(threadId)?.resolve(error instanceof Error ? error : new Error(String(error))); }
  }

  async startThread(request: StartThreadRequest) {
    this.profiles.set(request.requestId, this.profile);
    const config = this.profile.effort ? { model_reasoning_effort: this.profile.effort } : undefined;
    let response: Awaited<ReturnType<CodexAppServer['startThread']>>;
    try {
      response = await this.server.startThread({
        ...(this.profile.model ? { model: this.profile.model } : {}),
        ...(config ? { config } : {}), ...(request.cwd ? { cwd: request.cwd } : {}),
      });
    } catch (error) {
      if (error && typeof error === 'object' && (error as { outcome?: unknown }).outcome === 'unknown') throw new DispatchUncertainError(error instanceof Error ? error.message : 'Codex thread creation outcome is unknown');
      throw error;
    }
    if (this.profile.model && response.model !== this.profile.model) this.profileError = `Codex thread model mismatch: expected ${this.profile.model}, received ${response.model}`;
    if (this.profile.effort && response.reasoningEffort !== this.profile.effort) this.profileError = `Codex thread reasoning effort mismatch: expected ${this.profile.effort}, received ${response.reasoningEffort}`;
    return { threadId: response.thread.id, requestId: request.requestId };
  }

  async setThreadName(threadId: string, title: string): Promise<void> {
    if (this.profileError) throw new Error(this.profileError);
    await this.server.setThreadName({ threadId, name: title });
  }

  async startTurn(request: StartTurnRequest): Promise<TurnResult> {
    const completion = new Promise<Completion | Error>(resolve => this.active.set(request.threadId, { resolve }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const profile = this.profiles.get(request.requestId) ?? this.profile;
      const { turn } = await this.server.startTurn({
        threadId: request.threadId,
        input: [{ type: 'text', text: request.prompt, text_elements: [] }],
        clientUserMessageId: randomUUID(),
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.effort ? { effort: profile.effort } : {}),
      });
      const timeoutMs = profile.timeoutMs ?? 30_000;
      const final = await Promise.race([completion, new Promise<Error>(resolve => { timer = setTimeout(() => resolve(new Error('Codex turn completion is unknown after timeout')), timeoutMs); })]);
      if (final instanceof Error) return { turnId: turn.id, outcome: 'unknown', detail: final.message };
      if (final.turn.id !== turn.id || !['completed', 'failed', 'interrupted'].includes(String(final.turn.status))) return { turnId: turn.id, outcome: 'unknown', detail: 'Codex returned an unrecognized turn completion' };
      if (final.turn.status === 'completed') return { turnId: turn.id, outcome: 'succeeded' };
      return { turnId: turn.id, outcome: 'failed', detail: final.turn.error?.message ?? `Codex turn ${final.turn.status}` };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { outcome: error instanceof CodexRequestError && error.outcome === 'unknown' ? 'unknown' : 'failed', detail };
    } finally {
      if (timer) clearTimeout(timer);
      this.active.delete(request.threadId);
    }
  }

  async readThread(threadId: string): Promise<ReadThreadResult> {
    const { thread } = await this.server.readThread({ threadId });
    const page = await this.server.listTurns({ threadId, limit: 1, itemsView: 'summary' });
    const latest = page.data[0];
    return { threadId, exists: true, initialized: latest?.status === 'completed', ...(latest ? { detail: `latest turn ${latest.status}` } : { detail: 'thread exists without turns' }) };
  }
}

const inactiveAdapter: DispatchAdapter = {
  async startThread() { throw new Error('Codex app-server is not active'); },
  async setThreadName() { throw new Error('Codex app-server is not active'); },
  async startTurn() { throw new Error('Codex app-server is not active'); },
  async readThread() { throw new Error('Codex app-server is not active'); },
};

function report(record: DispatchRecord): void {
  const state = record.state === 'created' ? 'unknown' : record.state;
  const detail = record.state === 'created' ? 'A prior process stopped while the external thread creation result was unresolved; automatic retry is disabled' : record.detail ?? null;
  console.log(JSON.stringify({ requestId: record.requestId, dispatchId: record.id, state, threadId: record.threadId ?? null, turnId: record.turnId ?? null, attempts: record.attempts, detail }));
  if (state === 'failed') process.exitCode = 1;
  if (state === 'unknown') process.exitCode = 2;
}

export async function runCodexCommand(args: string[], configPath?: string): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === 'help') {
    console.log('codex dispatch REQUEST_ID JSON | list | reconcile DISPATCH_ID | approve DISPATCH_ID | retry DISPATCH_ID [accept|decline|cancel]'); return;
  }
  const config = await loadConfig(configPath);
  const dispatchDir = join(config.stateDir, 'codex-dispatch');
  const dispatcher = new ThreadDispatcher(inactiveAdapter, { stateDir: dispatchDir });
  if (command === 'list' && rest.length === 0) { console.log(JSON.stringify(await dispatcher.snapshotAsync())); return; }
  if (command === 'approve' && rest.length === 1) {
    const record = (await dispatcher.snapshotAsync()).find(item => item.id === rest[0]);
    if (!record) throw new Error('Dispatch request not found');
    if ((record.state === 'created' || record.state === 'unknown') && !record.threadId) throw new Error('Cannot approve a thread creation with no known thread ID; reconcile the external result first');
    report(await dispatcher.approve(rest[0]!)); return;
  }
  if (command === 'dispatch' && rest.length === 2) {
    const request = parseRequest(JSON.parse(rest[1]!), rest[0]!);
    const profileDir = join(config.stateDir, 'codex-profiles');
    await saveProfile(profileDir, request);
    const existing = (await dispatcher.snapshotAsync()).find(record => record.requestId === request.requestId);
    const input: DispatchInput = { requestId: request.requestId, title: request.title, prompt: request.prompt, ...(request.cwd ? { cwd: request.cwd } : {}) };
    if (existing) { report(existing); return; }
    const server = await CodexAppServer.start({ shutdownGraceMs: 500 });
    try { report(await new ThreadDispatcher(new AppServerDispatchAdapter(server, request, request.approvalDecision), { stateDir: dispatchDir }).dispatch(input)); }
    finally { await server.stop(); }
    return;
  }
  if (command === 'reconcile' && rest.length === 1) {
    const existing = (await dispatcher.snapshotAsync()).find(record => record.id === rest[0]);
    if (!existing) throw new Error('Dispatch request not found');
    if (existing.state === 'unknown' && !existing.threadId) throw new Error('Cannot retry an unknown thread creation without reconciling its thread ID');
    if (!existing.threadId) { report(existing); return; }
    if (existing.state !== 'unknown') { report(existing); return; }
    const profile = await readProfile(join(config.stateDir, 'codex-profiles'), existing.requestId);
    const server = await CodexAppServer.start();
    try { report(await new ThreadDispatcher(new AppServerDispatchAdapter(server, profile), { stateDir: dispatchDir }).reconcile(existing.id)); }
    finally { await server.stop(); }
    return;
  }
  if (command === 'retry' && (rest.length === 1 || rest.length === 2)) {
    if (rest[1] && !decisions.has(rest[1] as ApprovalDecision)) throw new Error('Approval decision must be accept, decline or cancel');
    const existing = (await dispatcher.snapshotAsync()).find(record => record.id === rest[0]);
    if (!existing) throw new Error('Dispatch request not found');
    const profile = await readProfile(join(config.stateDir, 'codex-profiles'), existing.requestId);
    const server = await CodexAppServer.start();
    try { report(await new ThreadDispatcher(new AppServerDispatchAdapter(server, profile, rest[1] as ApprovalDecision | undefined), { stateDir: dispatchDir }).retry(existing.id)); }
    finally { await server.stop(); }
    return;
  }
  throw new Error('Invalid codex command; see help');
}
