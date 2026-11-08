import { type ClientConfig, loadConfig } from './config.ts';
import { Ledger } from './tasks/ledger.ts';
import { runProcess, type ProcessOptions } from './runtime/process.ts';
import type { Receipt } from './tasks/ledger.ts';

export interface TaskRunOptions extends Omit<ProcessOptions, 'timeoutMs' | 'maxOutputBytes'> {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export class LocalClient {
  private readonly active = new Set<AbortController>();
  private readonly runs = new Set<Promise<Receipt>>();
  private readonly requests = new Map<string, { taskId: string; command: string[]; promise: Promise<Receipt> }>();
  private closing = false;
  private constructor(readonly config: ClientConfig, readonly ledger: Ledger) {}
  static async open(configPath?: string): Promise<LocalClient> {
    const config = await loadConfig(configPath);
    return new LocalClient(config, await Ledger.open(config.stateDir));
  }
  /** Execute one task attempt and persist its outcome before returning. */
  runTask(operationId: string, taskId: string, command: readonly string[], options: TaskRunOptions = {}): Promise<Receipt> {
    if (this.closing) return Promise.reject(new Error('Client is closed'));
    if (!Array.isArray(command) || command.length === 0 || command.some(arg => typeof arg !== 'string') || !command[0]) return Promise.reject(new Error('Invalid task command'));
    const previous = this.requests.get(operationId);
    if (previous) {
      if (previous.taskId !== taskId || JSON.stringify(previous.command) !== JSON.stringify(command)) return Promise.reject(new Error('Operation identity conflict'));
      return previous.promise;
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    this.active.add(controller);
    const promise = this.executeTask(operationId, taskId, command, options, controller.signal)
      .finally(() => { options.signal?.removeEventListener('abort', forwardAbort); this.active.delete(controller); });
    this.requests.set(operationId, { taskId, command: [...command], promise });
    this.runs.add(promise);
    void promise.then(() => this.runs.delete(promise), () => this.runs.delete(promise));
    return promise;
  }

  private async executeTask(operationId: string, taskId: string, command: readonly string[], options: TaskRunOptions, signal: AbortSignal): Promise<Receipt> {
    const startId = `${operationId}.start`;
    const finishId = `${operationId}.finish`;
    const priorStart = this.ledger.history().find(receipt => receipt.operationId === startId);
    await this.ledger.execute(startId, { type: 'run.start', taskId, runId: `${operationId}.run`, command: [...command] });
    if (priorStart) {
      const priorFinish = this.ledger.history().find(receipt => receipt.operationId === finishId);
      if (!priorFinish) throw new Error('Uncertain previous execution; inspect receipts before retrying');
      return priorFinish;
    }
    let status: 'succeeded' | 'failed' | 'interrupted' = 'failed';
    let detail: string;
    try {
      const task = this.ledger.snapshot().tasks[taskId];
      const processOptions: ProcessOptions = {
        timeoutMs: options.timeoutMs ?? this.config.processTimeoutMs,
        maxOutputBytes: options.maxOutputBytes ?? this.config.maxOutputBytes,
        signal,
      };
      const cwd = options.cwd ?? task?.repository;
      if (cwd !== undefined) processOptions.cwd = cwd;
      if (options.env !== undefined) processOptions.env = options.env;
      const result = await runProcess(command[0]!, command.slice(1), processOptions);
      status = result.code === 0 ? 'succeeded' : 'failed';
      detail = JSON.stringify(result);
    } catch (error) {
      status = signal.aborted ? 'interrupted' : 'failed';
      detail = error instanceof Error ? error.message : String(error);
    }
    return this.ledger.execute(finishId, { type: 'run.finish', runId: `${operationId}.run`, status, detail });
  }

  async close(): Promise<void> {
    if (this.closing) { await Promise.allSettled(this.runs); return; }
    this.closing = true;
    for (const controller of this.active) controller.abort();
    await Promise.allSettled(this.runs);
    await this.ledger.close();
  }

  async stop(): Promise<void> { await this.close(); }
}
