import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../runtime/files.js';
import { StateLock } from '../runtime/lock.js';

export interface StartThreadRequest {
  requestId: string;
  title: string;
  cwd?: string;
}

export interface ThreadIdentity {
  threadId: string;
  requestId?: string;
}

export interface StartTurnRequest {
  requestId: string;
  threadId: string;
  prompt: string;
}

export interface TurnResult {
  turnId?: string;
  outcome?: 'succeeded' | 'failed' | 'unknown';
  detail?: string;
}

export interface ReadThreadResult {
  threadId: string;
  exists: boolean;
  initialized?: boolean;
  detail?: string;
}

/** The smallest adapter surface needed by dispatch. Concrete Codex wiring stays elsewhere. */
export interface DispatchAdapter {
  startThread(request: StartThreadRequest): Promise<ThreadIdentity>;
  setThreadName(threadId: string, title: string): Promise<void>;
  startTurn(request: StartTurnRequest): Promise<TurnResult>;
  readThread(threadId: string): Promise<ReadThreadResult>;
}

export type DispatchState =
  | 'created'
  | 'started'
  | 'initialized'
  | 'failed'
  | 'unknown'
  | 'reconciled'
  | 'approved';

export interface DispatchInput {
  requestId: string;
  title: string;
  prompt: string;
  cwd?: string;
}

export interface DispatchRecord extends DispatchInput {
  id: string;
  threadId?: string;
  turnId?: string;
  state: DispatchState;
  attempts: number;
  detail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DispatchOptions {
  /** Directory for the dispatch journal. Omit for process-local use in isolated tests. */
  stateDir?: string;
}

interface DispatchJournal {
  schemaVersion: 1;
  records: DispatchRecord[];
}

export class DispatchUncertainError extends Error {
  readonly uncertain = true;
  constructor(message = 'Dispatch result is uncertain') {
    super(message);
    this.name = 'DispatchUncertainError';
  }
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function inputKey(input: DispatchInput): string {
  return JSON.stringify({ requestId: input.requestId, title: input.title, prompt: input.prompt, cwd: input.cwd ?? null });
}

function uncertain(error: unknown): boolean {
  return error instanceof DispatchUncertainError || (typeof error === 'object' && error !== null && (error as { uncertain?: unknown }).uncertain === true);
}

/**
 * Idempotent thread dispatch with an explicit reconciliation and approval boundary.
 * A failed or unknown external call is retained and is never replayed implicitly.
 */
export class ThreadDispatcher {
  private readonly records = new Map<string, DispatchRecord>();
  private readonly identities = new Map<string, string>();
  private readonly requests = new Map<string, { key: string; id: string }>();

  constructor(private readonly adapter: DispatchAdapter, private readonly options: DispatchOptions = {}) {}

  private journalPath(): string | undefined {
    return this.options.stateDir ? join(this.options.stateDir, 'dispatch.json') : undefined;
  }

  private async readPersistent(): Promise<DispatchRecord[]> {
    const path = this.journalPath();
    if (!path) return [...this.records.values()];
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as DispatchJournal;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) throw new Error('Invalid dispatch journal');
      return parsed.records.map(record => structuredClone(record));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private cache(records: readonly DispatchRecord[]): void {
    this.records.clear(); this.identities.clear(); this.requests.clear();
    for (const record of records) {
      this.records.set(record.id, structuredClone(record));
      const key = inputKey(record);
      this.identities.set(key, record.id);
      this.requests.set(record.requestId, { key, id: record.id });
    }
  }

  private async withState<T>(mutator: (records: DispatchRecord[]) => T | Promise<T>): Promise<T> {
    const path = this.journalPath();
    if (!path) {
      const records = [...this.records.values()];
      const result = await mutator(records);
      this.cache(records);
      return result;
    }
    let lastError: unknown;
    // Durable fsync can exceed 200 ms on a healthy filesystem. Wait without reclaiming the owner.
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      let lock: StateLock | undefined;
      try {
        lock = await StateLock.acquire(this.options.stateDir!);
        const records = await this.readPersistent();
        const result = await mutator(records);
        await atomicWrite(path, { schemaVersion: 1, records });
        this.cache(records);
        return result;
      } catch (error) {
        lastError = error;
        if (!(error instanceof Error) || !error.message.startsWith('State directory locked:')) throw error;
        await new Promise(resolve => setTimeout(resolve, 5));
      } finally {
        if (lock) await lock.release();
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Unable to acquire dispatch state lock');
  }

  private async load(): Promise<void> {
    if (this.journalPath()) this.cache(await this.readPersistent());
  }

  snapshot(): DispatchRecord[] {
    return structuredClone([...this.records.values()]);
  }

  async snapshotAsync(): Promise<DispatchRecord[]> {
    await this.load();
    return this.snapshot();
  }

  get(id: string): DispatchRecord | undefined {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async dispatch(input: DispatchInput): Promise<DispatchRecord> {
    if (!nonempty(input.requestId) || !nonempty(input.title) || !nonempty(input.prompt)) throw new Error('Dispatch request requires requestId, title and prompt');
    const key = inputKey(input);
    const reservation = await this.withState(records => {
      const priorRequest = records.find(record => record.requestId === input.requestId);
      if (priorRequest) {
        if (inputKey(priorRequest) !== key) throw new Error('Dispatch operation identity conflict');
        return { record: structuredClone(priorRequest), created: false };
      }
      const existing = records.find(record => inputKey(record) === key);
      if (existing) return { record: structuredClone(existing), created: false };
      const now = new Date().toISOString();
      const record: DispatchRecord = { ...input, id: randomUUID(), state: 'created', attempts: 1, createdAt: now, updatedAt: now };
      records.push(record);
      return { record: structuredClone(record), created: true };
    });
    if (!reservation.created) return reservation.record;
    await this.perform(reservation.record.id);
    return this.get(reservation.record.id)!;
  }

  private async update(id: string, mutate: (record: DispatchRecord) => void): Promise<DispatchRecord> {
    return this.withState(records => {
      const record = records.find(item => item.id === id);
      if (!record) throw new Error('Dispatch request not found');
      mutate(record);
      record.updatedAt = new Date().toISOString();
      return structuredClone(record);
    });
  }

  private async perform(id: string): Promise<void> {
    const record = this.get(id);
    if (!record) throw new Error('Dispatch request not found');
    try {
      const identity = await this.adapter.startThread({ requestId: record.requestId, title: record.title, ...(record.cwd ? { cwd: record.cwd } : {}) });
      if (!identity || !nonempty(identity.threadId)) throw new DispatchUncertainError('Adapter did not return a thread identity');
      await this.update(id, current => { current.threadId = identity.threadId; current.state = 'started'; });
      await this.adapter.setThreadName(identity.threadId, record.title);
      const turn = await this.adapter.startTurn({ requestId: record.requestId, threadId: identity.threadId, prompt: record.prompt });
      if (turn.outcome === 'unknown') throw new DispatchUncertainError(turn.detail ?? 'Initialization turn result is unknown');
      if (turn.outcome === 'failed') {
        await this.update(id, current => { current.state = 'failed'; current.detail = turn.detail ?? 'Initialization turn failed'; });
        return;
      }
      await this.update(id, current => { if (turn.turnId) current.turnId = turn.turnId; current.state = 'initialized'; });
    } catch (error) {
      await this.update(id, current => { current.state = uncertain(error) ? 'unknown' : 'failed'; current.detail = error instanceof Error ? error.message : String(error); });
    }
  }

  /** Query the adapter after an unknown result; this never starts a second thread. */
  async reconcile(id: string): Promise<DispatchRecord> {
    await this.load();
    const record = this.records.get(id);
    if (!record) throw new Error('Dispatch request not found');
    if (record.state !== 'unknown') return structuredClone(record);
    if (!record.threadId) return structuredClone(record);
    try {
      const result = await this.adapter.readThread(record.threadId);
      if (result.exists) {
        await this.update(id, current => { current.state = result.initialized === true ? 'initialized' : 'started'; if (result.detail) current.detail = result.detail; });
      }
      return this.get(id)!;
    } catch (error) {
      return this.update(id, current => { current.detail = error instanceof Error ? error.message : String(error); });
    }
  }

  /** Explicit human approval is required before replaying an uncertain dispatch. */
  async approve(id: string): Promise<DispatchRecord> {
    await this.load();
    const record = this.records.get(id);
    if (!record) throw new Error('Dispatch request not found');
    if (record.state !== 'unknown' && record.state !== 'reconciled' && record.state !== 'started' && record.state !== 'failed') throw new Error('Dispatch is not awaiting approval');
    return this.update(id, current => { current.state = 'approved'; });
  }

  async retry(id: string): Promise<DispatchRecord> {
    await this.load();
    const record = this.records.get(id);
    if (!record) throw new Error('Dispatch request not found');
    if (record.state !== 'approved') throw new Error('Dispatch retry requires explicit approval');
    await this.update(id, current => { current.attempts += 1; current.state = current.threadId ? 'started' : 'created'; delete current.detail; });
    if (record.threadId) {
      try {
        const turn = await this.adapter.startTurn({ requestId: record.requestId, threadId: record.threadId, prompt: record.prompt });
        if (turn.outcome === 'unknown') throw new DispatchUncertainError(turn.detail ?? 'Initialization turn result is unknown');
        if (turn.outcome === 'failed') {
          await this.update(id, current => { current.state = 'failed'; current.detail = turn.detail ?? 'Initialization turn failed'; });
        } else {
          await this.update(id, current => { if (turn.turnId) current.turnId = turn.turnId; current.state = 'initialized'; });
        }
      } catch (error) {
        await this.update(id, current => { current.state = uncertain(error) ? 'unknown' : 'failed'; current.detail = error instanceof Error ? error.message : String(error); });
      }
    } else await this.perform(id);
    return this.get(id)!;
  }
}

export class FakeDispatchAdapter implements DispatchAdapter {
  readonly calls = { startThread: 0, setThreadName: 0, startTurn: 0, readThread: 0 };
  readonly threads = new Map<string, { title: string; initialized: boolean }>();
  startThreadResult: ThreadIdentity | undefined;
  startThreadError: Error | undefined;
  startThreadUncertain = false;
  startTurnResult: TurnResult = { outcome: 'succeeded', turnId: 'turn-1' };
  startTurnError: Error | undefined;

  async startThread(request: StartThreadRequest): Promise<ThreadIdentity> {
    this.calls.startThread += 1;
    if (this.startThreadError) throw this.startThreadError;
    const identity = this.startThreadResult ?? { threadId: `thread-${this.calls.startThread}`, requestId: request.requestId };
    this.threads.set(identity.threadId, { title: request.title, initialized: false });
    if (this.startThreadUncertain) throw new DispatchUncertainError('Thread creation outcome is unknown');
    return identity;
  }
  async setThreadName(threadId: string, title: string): Promise<void> {
    this.calls.setThreadName += 1;
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error('Thread not found');
    thread.title = title;
  }
  async startTurn(request: StartTurnRequest): Promise<TurnResult> {
    this.calls.startTurn += 1;
    if (this.startTurnError) throw this.startTurnError;
    const thread = this.threads.get(request.threadId);
    if (!thread) throw new Error('Thread not found');
    if (this.startTurnResult.outcome !== 'failed' && this.startTurnResult.outcome !== 'unknown') thread.initialized = true;
    return this.startTurnResult;
  }
  async readThread(threadId: string): Promise<ReadThreadResult> {
    this.calls.readThread += 1;
    const thread = this.threads.get(threadId);
    return thread ? { threadId, exists: true, initialized: thread.initialized } : { threadId, exists: false };
  }
}
