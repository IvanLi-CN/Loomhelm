import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type * as P from './protocol.js';

export type RpcId = string | number;
export interface RpcError { code: number; message: string; data?: unknown }
export interface Notification { method: string; params?: unknown }
export interface ServerCall extends Notification {
  id: RpcId;
  /** Approval requests are never answered implicitly. Params remain unmodified. */
  approval: boolean;
  respond(result: unknown): Promise<void>;
  reject(error: RpcError): Promise<void>;
}
export type ConnectionState = 'initializing' | 'ready' | 'disconnected' | 'stopping' | 'closed';
export type EventName = 'notification' | 'serverRequest' | 'orphanResponse' | 'disconnect' | 'stderr' | 'handlerError';
export interface AppServerOptions {
  command?: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  initialize?: P.InitializeParams;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
  maxFrameBytes?: number;
  maxPendingRequests?: number;
  /** Attach before initialize so early server requests cannot be lost. */
  onEvent?: (event: EventName, value: unknown) => void;
}
export class CodexRequestError extends Error {
  constructor(message: string, readonly requestId: RpcId, readonly method: string,
    readonly outcome: 'unknown' | 'rejected' | 'not-sent', readonly rpcError?: RpcError) {
    super(message); this.name = 'CodexRequestError';
  }
}
interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
const approvals = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'applyPatchApproval', 'execCommandApproval']);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const rpcId = (value: unknown): value is RpcId => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error(`Invalid ${name}`);
  return value;
}

/** One owned stdio process, one handshake. No automatic reconnect or mutation replay. */
export class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly events = new EventEmitter();
  private readonly pending = new Map<RpcId, Pending>();
  private readonly inbound = new Map<RpcId, ServerCall>();
  private readonly prefix = randomUUID();
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private currentState: ConnectionState = 'initializing';
  private readonly timeout: number;
  private readonly grace: number;
  private readonly frameLimit: number;
  private readonly pendingLimit: number;
  private stopPromise: Promise<void> | undefined;
  private readonly closed: Promise<void>;
  initializeResult!: P.InitializeResponse;

  private constructor(private readonly options: AppServerOptions) {
    this.timeout = positive(options.requestTimeoutMs ?? 30_000, 'requestTimeoutMs');
    this.grace = positive(options.shutdownGraceMs ?? 500, 'shutdownGraceMs');
    this.frameLimit = positive(options.maxFrameBytes ?? 8 * 1024 * 1024, 'maxFrameBytes');
    this.pendingLimit = positive(options.maxPendingRequests ?? 1024, 'maxPendingRequests');
    this.child = spawn(options.command ?? 'codex', [...(options.args ?? ['app-server', '--listen', 'stdio://'])], {
      cwd: options.cwd, env: options.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.disconnect(new Error(`Codex app-server closed (code=${code}, signal=${signal})`));
      this.currentState = 'closed'; resolve();
    }));
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stdout.on('error', error => this.fail(error));
    this.child.stderr.on('error', error => this.fail(error));
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stdout.once('end', () => this.fail(new Error('Codex app-server stdout ended')));
    this.child.stderr.on('data', (chunk: Buffer) => this.publish('stderr', chunk.toString('utf8')));
  }

  static async start(options: AppServerOptions = {}): Promise<CodexAppServer> {
    const client = new CodexAppServer(options);
    try {
      client.initializeResult = await client.rpc('initialize', options.initialize ?? {
        clientInfo: { name: 'loomhelm', title: 'Loomhelm', version: '0.1.0' }, capabilities: null,
      }) as P.InitializeResponse;
      await client.write({ method: 'initialized' });
      if (client.currentState !== 'initializing') throw new Error('Codex disconnected during initialization');
      client.currentState = 'ready';
      return client;
    } catch (error) { await client.stop(); throw error; }
  }

  get state(): ConnectionState { return this.currentState; }
  get pid(): number | undefined { return this.child.pid; }
  /** Returns an unsubscribe function. Listener failures emit handlerError. */
  on(event: 'notification', listener: (value: Notification) => void): () => void;
  on(event: 'serverRequest', listener: (value: ServerCall) => void): () => void;
  on(event: 'disconnect' | 'handlerError', listener: (value: Error) => void): () => void;
  on(event: 'stderr', listener: (value: string) => void): () => void;
  on(event: 'orphanResponse', listener: (value: unknown) => void): () => void;
  on(event: string, listener: (...args: any[]) => void): () => void {
    this.events.on(event, listener); return () => { this.events.off(event, listener); };
  }
  private publish(event: EventName, value: unknown): void {
    for (const listener of [() => this.options.onEvent?.(event, value), ...this.events.listeners(event).map(fn => () => fn(value))]) {
      try {
        const value = listener();
        if (value instanceof Promise) void value.catch(error => {
          if (event !== 'handlerError') this.publish('handlerError', error instanceof Error ? error : new Error(String(error)));
        });
      } catch (error) {
        if (event !== 'handlerError') this.publish('handlerError', error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  private encode(message: unknown): string {
    const frame = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(frame) > this.frameLimit) throw new Error('Outgoing Codex frame exceeds limit');
    return frame;
  }
  private writeFrame(frame: string): Promise<void> {
    if (!['initializing', 'ready'].includes(this.currentState)) return Promise.reject(new Error('Codex connection is not writable'));
    return new Promise((resolve, reject) => this.child.stdin.write(frame, error => error ? reject(error) : resolve()));
  }
  private write(message: unknown): Promise<void> {
    try { return this.writeFrame(this.encode(message)); } catch (error) { return Promise.reject(error); }
  }
  private rpc(method: string, params: unknown): Promise<unknown> {
    const id = `${this.prefix}:${++this.sequence}`;
    if (!['initializing', 'ready'].includes(this.currentState) || this.pending.size >= this.pendingLimit) {
      return Promise.reject(new CodexRequestError('Codex unavailable or pending request limit reached', id, method, 'not-sent'));
    }
    // Local serialization errors are definite; failures after write begins are uncertain.
    let frame: string;
    try { frame = this.encode({ id, method, params }); } catch (error) { return Promise.reject(new CodexRequestError(String(error), id, method, 'not-sent')); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRequestError('Codex response timed out; reconcile before retry', id, method, 'unknown'));
      }, this.timeout);
      this.pending.set(id, { method, resolve, reject, timer });
      void this.writeFrame(frame).catch(error => {
        if (this.pending.has(id)) {
          clearTimeout(timer); this.pending.delete(id);
          reject(new CodexRequestError(String(error), id, method, 'unknown'));
        }
      });
    });
  }
  private request<T>(method: string, params: unknown): Promise<T> {
    if (this.currentState !== 'ready') return Promise.reject(new Error('Codex app-server is not ready'));
    return this.rpc(method, params) as Promise<T>;
  }
  private receive(chunk: Buffer): void {
    if (!['initializing', 'ready'].includes(this.currentState)) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end: number;
    while ((end = this.buffer.indexOf(10)) !== -1) {
      if (end > this.frameLimit) { this.fail(new Error('Codex frame exceeds limit')); return; }
      const line = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 1);
      if (!line.trim()) continue;
      try { this.route(JSON.parse(line)); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); return; }
      if (!['initializing', 'ready'].includes(this.currentState)) return;
    }
    if (this.buffer.length > this.frameLimit) this.fail(new Error('Codex frame exceeds limit'));
  }
  private route(message: unknown): void {
    if (!object(message)) throw new Error('Invalid Codex RPC message');
    if ('method' in message) {
      if (typeof message.method !== 'string' || !message.method) throw new Error('Invalid Codex RPC method');
      if (!('id' in message)) {
        if (message.method === 'serverRequest/resolved' && object(message.params) && rpcId(message.params.requestId)) this.inbound.delete(message.params.requestId);
        this.publish('notification', message); return;
      }
      if (!rpcId(message.id)) throw new Error('Invalid Codex server request id');
      if (this.inbound.has(message.id)) throw new Error('Duplicate unresolved Codex server request id');
      if (this.inbound.size >= this.pendingLimit) throw new Error('Codex server request limit reached');
      const id = message.id;
      const answer = async (body: object) => {
        if (this.inbound.get(id) !== call) throw new Error('Codex server request already answered or disconnected');
        // Invalid owner input leaves the approval pending for an explicit corrected reply.
        const response = { id, ...body };
        const encoded = this.encode(response);
        if (!('result' in JSON.parse(encoded)) && !('error' in JSON.parse(encoded))) throw new Error('Codex server response must contain result or error');
        this.inbound.delete(id);
        try { await this.writeFrame(encoded); } catch (error) { this.fail(new Error('Codex server response delivery failed')); throw error; }
      };
      const call: ServerCall = Object.freeze({ id, method: message.method, params: message.params,
        approval: approvals.has(message.method), respond: (result: unknown) => answer({ result }), reject: (error: RpcError) => answer({ error }) });
      this.inbound.set(id, call); this.publish('serverRequest', call); return;
    }
    if (!rpcId(message.id) || ('result' in message) === ('error' in message)) throw new Error('Invalid Codex RPC response');
    if ('error' in message && (!object(message.error) || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string')) throw new Error('Invalid Codex RPC error');
    const pending = this.pending.get(message.id);
    if (!pending) { this.publish('orphanResponse', message); return; }
    if ('result' in message && !this.validResult(pending.method, message.result)) throw new Error(`Invalid Codex ${pending.method} result`);
    clearTimeout(pending.timer); this.pending.delete(message.id);
    if ('error' in message) {
      const error = message.error as unknown as RpcError;
      pending.reject(new CodexRequestError(error.message, message.id, pending.method, 'rejected', error));
    } else pending.resolve(message.result);
  }
  /** Validate identity-bearing shapes while preserving forward-compatible extra fields. */
  private validResult(method: string, result: unknown): boolean {
    if (!object(result)) return false;
    const identity = (value: unknown) => object(value) && typeof value.id === 'string' && value.id.length > 0;
    if (method === 'initialize') return ['userAgent', 'codexHome', 'platformFamily', 'platformOs'].every(key => typeof result[key] === 'string');
    if (['thread/start', 'thread/resume', 'thread/fork', 'thread/read'].includes(method)) return identity(result.thread);
    if (method === 'turn/start') return identity(result.turn) && object(result.turn) && ['inProgress', 'completed', 'interrupted', 'failed'].includes(String(result.turn.status));
    if (['thread/list', 'thread/turns/list', 'model/list'].includes(method)) return Array.isArray(result.data) && (result.nextCursor === null || typeof result.nextCursor === 'string');
    return true;
  }
  private disconnect(error: Error): void {
    if (['disconnected', 'closed', 'stopping'].includes(this.currentState)) return;
    this.currentState = 'disconnected';
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CodexRequestError(error.message, id, pending.method, 'unknown'));
    }
    this.pending.clear(); this.inbound.clear(); this.buffer = Buffer.alloc(0);
    this.publish('disconnect', error);
  }
  private fail(error: Error): void { this.disconnect(error); void this.stop(); }

  /** Close stdin, then TERM/KILL only this directly owned child; await actual close. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.currentState === 'closed') return Promise.resolve();
    let terminate: ReturnType<typeof setTimeout>, kill: ReturnType<typeof setTimeout>;
    this.stopPromise = this.closed.finally(() => { clearTimeout(terminate); clearTimeout(kill); });
    this.disconnect(new Error('Codex app-server stopped'));
    this.currentState = 'stopping'; this.child.stdin.end();
    terminate = setTimeout(() => this.child.kill('SIGTERM'), this.grace);
    kill = setTimeout(() => this.child.kill('SIGKILL'), Math.min(this.grace * 2, 2_147_483_647));
    return this.stopPromise;
  }

  startThread(params: P.ThreadStartParams = {}) { return this.request<P.ThreadStartResponse>('thread/start', params); }
  resumeThread(params: P.ThreadResumeParams) { return this.request<P.ThreadResumeResponse>('thread/resume', params); }
  forkThread(params: P.ThreadForkParams) { return this.request<P.ThreadForkResponse>('thread/fork', params); }
  readThread(params: P.ThreadReadParams) { return this.request<P.ThreadReadResponse>('thread/read', params); }
  listThreads(params: P.ThreadListParams = {}) { return this.request<P.ThreadListResponse>('thread/list', params); }
  listTurns(params: P.ThreadTurnsListParams) { return this.request<P.ThreadTurnsListResponse>('thread/turns/list', params); }
  setThreadName(params: P.ThreadSetNameParams) { return this.request<Record<string, never>>('thread/name/set', params); }
  startTurn(params: P.TurnStartParams) { return this.request<P.TurnStartResponse>('turn/start', params); }
  interruptTurn(params: P.TurnInterruptParams) { return this.request<P.TurnInterruptResponse>('turn/interrupt', params); }
  listModels(params: P.ModelListParams = {}) { return this.request<P.ModelListResponse>('model/list', params); }
}
