import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../runtime/files.js';
import { StateLock } from '../runtime/lock.js';
import { applyOperation, emptyState, identifier, type Operation, type TaskState } from './model.js';

export interface Receipt { sequence: number; operationId: string; at: string; operation: Operation; previousHash: string; hash: string }
const genesis = '0'.repeat(64);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

/** A single local writer, immutable fact history, atomically replaced file. */
export class Ledger {
  private receipts: Receipt[] = [];
  private state = emptyState();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(private path: string, private lock: StateLock) {}
  static async open(directory: string): Promise<Ledger> {
    const lock = await StateLock.acquire(directory);
    const ledger = new Ledger(join(directory, 'ledger.json'), lock);
    try {
      let text: string | undefined;
      try { text = await readFile(ledger.path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (text !== undefined) {
        const data = JSON.parse(text);
        if (data.schemaVersion !== 1 || !Array.isArray(data.receipts)) throw new Error('Unsupported or invalid ledger');
        const identities = new Set<string>();
        for (const receipt of data.receipts as Receipt[]) {
          identifier(receipt.operationId);
          const { hash, ...body } = receipt;
          if (receipt.sequence !== ledger.receipts.length + 1 || identities.has(receipt.operationId) || receipt.previousHash !== (ledger.receipts.at(-1)?.hash ?? genesis) || hash !== digest(body) || typeof receipt.at !== 'string' || !Number.isFinite(Date.parse(receipt.at))) throw new Error('Invalid receipt chain');
          applyOperation(ledger.state, receipt.operation, receipt.at);
          ledger.receipts.push(receipt); identities.add(receipt.operationId);
        }
      }
      // An uncertain external side effect is never silently retried.
      for (const run of Object.values(ledger.state.runs)) if (run.status === 'running') {
        await ledger.execute(`recovery.${randomUUID()}`, { type: 'run.finish', runId: run.id, status: 'interrupted', detail: 'Client restarted; reconcile external effects before retry' });
      }
      return ledger;
    } catch (error) { await lock.release(); throw error; }
  }
  snapshot(): TaskState { return structuredClone(this.state); }
  history(): Receipt[] { return structuredClone(this.receipts); }
  execute(operationId: string, operation: Operation): Promise<Receipt> {
    if (this.closed) return Promise.reject(new Error('Ledger closed'));
    // Capture caller input before asynchronous execution.
    const input = JSON.parse(JSON.stringify(operation)) as Operation;
    const action = this.queue.then(async () => {
      identifier(operationId);
      const prior = this.receipts.find(receipt => receipt.operationId === operationId);
      if (prior) {
        if (canonical(prior.operation) !== canonical(input)) throw new Error('Operation identity conflict');
        return structuredClone(prior);
      }
      const at = new Date().toISOString();
      const next = structuredClone(this.state);
      applyOperation(next, input, at);
      const body = { sequence: this.receipts.length + 1, operationId, at, operation: input, previousHash: this.receipts.at(-1)?.hash ?? genesis };
      const receipt = { ...body, hash: digest(body) };
      const receipts = [...this.receipts, receipt];
      await atomicWrite(this.path, { schemaVersion: 1, receipts });
      this.receipts = receipts; this.state = next;
      return structuredClone(receipt);
    });
    this.queue = action.catch(() => {});
    return action;
  }
  async close(): Promise<void> {
    if (this.closed) { await this.queue; return; }
    this.closed = true;
    await this.queue;
    await this.lock.release();
  }
}
