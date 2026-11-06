import { randomUUID } from 'node:crypto';

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

  constructor(private readonly adapter: DispatchAdapter) {}

  snapshot(): DispatchRecord[] {
    return structuredClone([...this.records.values()]);
  }

  get(id: string): DispatchRecord | undefined {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async dispatch(input: DispatchInput): Promise<DispatchRecord> {
    if (!nonempty(input.requestId) || !nonempty(input.title) || !nonempty(input.prompt)) throw new Error('Dispatch request requires requestId, title and prompt');
    const key = inputKey(input);
    const priorRequest = this.requests.get(input.requestId);
    if (priorRequest) {
      if (priorRequest.key !== key) throw new Error('Dispatch operation identity conflict');
      return this.get(priorRequest.id)!;
    }
    const existingId = this.identities.get(key);
    if (existingId) return this.get(existingId)!;
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: DispatchRecord = { ...input, id, state: 'created', attempts: 1, createdAt: now, updatedAt: now };
    this.records.set(id, record);
    this.identities.set(key, id);
    this.requests.set(input.requestId, { key, id });
    await this.perform(record);
    return structuredClone(record);
  }

  private async perform(record: DispatchRecord): Promise<void> {
    try {
      const identity = await this.adapter.startThread({ requestId: record.requestId, title: record.title, ...(record.cwd ? { cwd: record.cwd } : {}) });
      if (!identity || !nonempty(identity.threadId)) throw new DispatchUncertainError('Adapter did not return a thread identity');
      record.threadId = identity.threadId;
      record.state = 'started';
      record.updatedAt = new Date().toISOString();
      await this.adapter.setThreadName(identity.threadId, record.title);
      const turn = await this.adapter.startTurn({ requestId: record.requestId, threadId: identity.threadId, prompt: record.prompt });
      if (turn.outcome === 'unknown') throw new DispatchUncertainError(turn.detail ?? 'Initialization turn result is unknown');
      if (turn.outcome === 'failed') {
        record.state = 'failed';
        record.detail = turn.detail ?? 'Initialization turn failed';
        record.updatedAt = new Date().toISOString();
        return;
      }
      if (turn.turnId) record.turnId = turn.turnId;
      record.state = 'initialized';
      record.updatedAt = new Date().toISOString();
    } catch (error) {
      record.state = uncertain(error) ? 'unknown' : 'failed';
      record.detail = error instanceof Error ? error.message : String(error);
      record.updatedAt = new Date().toISOString();
    }
  }

  /** Query the adapter after an unknown result; this never starts a second thread. */
  async reconcile(id: string): Promise<DispatchRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error('Dispatch request not found');
    if (record.state !== 'unknown') return structuredClone(record);
    if (!record.threadId) return structuredClone(record);
    try {
      const result = await this.adapter.readThread(record.threadId);
      if (result.exists) {
        record.state = result.initialized === true ? 'initialized' : 'started';
        if (result.detail) record.detail = result.detail;
      }
      record.updatedAt = new Date().toISOString();
      return structuredClone(record);
    } catch (error) {
      record.detail = error instanceof Error ? error.message : String(error);
      record.updatedAt = new Date().toISOString();
      return structuredClone(record);
    }
  }

  /** Explicit human approval is required before replaying an uncertain dispatch. */
  approve(id: string): DispatchRecord {
    const record = this.records.get(id);
    if (!record) throw new Error('Dispatch request not found');
    if (record.state !== 'unknown' && record.state !== 'reconciled' && record.state !== 'started' && record.state !== 'failed') throw new Error('Dispatch is not awaiting approval');
    record.state = 'approved';
    record.updatedAt = new Date().toISOString();
    return structuredClone(record);
  }

  async retry(id: string): Promise<DispatchRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error('Dispatch request not found');
    if (record.state !== 'approved') throw new Error('Dispatch retry requires explicit approval');
    record.attempts += 1;
    record.state = record.threadId ? 'started' : 'created';
    delete record.detail;
    record.updatedAt = new Date().toISOString();
    if (record.threadId) {
      try {
        const turn = await this.adapter.startTurn({ requestId: record.requestId, threadId: record.threadId, prompt: record.prompt });
        if (turn.outcome === 'unknown') throw new DispatchUncertainError(turn.detail ?? 'Initialization turn result is unknown');
        if (turn.outcome === 'failed') {
          record.state = 'failed';
          record.detail = turn.detail ?? 'Initialization turn failed';
        } else {
          if (turn.turnId) record.turnId = turn.turnId;
          record.state = 'initialized';
        }
      } catch (error) {
        record.state = uncertain(error) ? 'unknown' : 'failed';
        record.detail = error instanceof Error ? error.message : String(error);
      }
      record.updatedAt = new Date().toISOString();
    } else await this.perform(record);
    return structuredClone(record);
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
