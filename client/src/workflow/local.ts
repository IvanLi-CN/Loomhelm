import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { GitAdapter } from '../git.js';
import { runProcess } from '../runtime/process.js';

export type LocalStage = 'durable-contracts' | 'delivery-slices' | 'validation' | 'can-open-pr';
export type FlowType = 'normal' | 'fast-track' | 'local-merge';
export interface ContractDecision { kind: 'spec' | 'adr'; disposition: 'link' | 'not-needed'; reason: string; paths: string[] }
export interface ValidationEntry { id: string; command: string; args: string[]; required?: boolean; timeoutMs?: number; maxOutputBytes?: number }
export interface ValidationReceipt {
  id: string; entry: ValidationEntry; repository: string; base: string; head: string;
  startedAt: string; finishedAt: string; status: 'passed' | 'failed' | 'interrupted';
  code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string;
  error: string | null; outputDigest: string; candidateUnchanged: boolean;
}
export interface WorkflowSnapshot {
  flowType: FlowType; repository: string; branch: string; base: string; stage: LocalStage;
  contracts: { decision: ContractDecision; files: { path: string; digest: string }[] }[];
  implementation: string | null; validationHead: string | null; receipts: ValidationReceipt[];
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

/** Local stages only; callers own persistence and integration with task ledgers.
 * No push, PR, merge, release, formal review, or global Skill mutation. */
export class LocalWorkflow {
  private busy = false;
  private constructor(private state: WorkflowSnapshot) {}
  static async open(repository: string, baseRef: string, flowType: FlowType = 'normal'): Promise<LocalWorkflow> {
    if (!['normal', 'fast-track', 'local-merge'].includes(flowType)) throw new Error('Invalid flow type');
    if (!nonempty(baseRef) || baseRef.startsWith('-')) throw new Error('Explicit base required');
    const current = await new GitAdapter(repository).inspect();
    if (!current.branch || ['main', 'master'].includes(current.branch)) throw new Error('Topic branch required');
    if (current.dirty) throw new Error('Clean candidate required; preserve existing changes');
    const result = await runProcess('git', ['-C', current.root, 'rev-parse', '--verify', `${baseRef}^{commit}`]);
    if (result.code !== 0) throw new Error('Unable to resolve base');
    const base = result.stdout.trim();
    const ancestor = await runProcess('git', ['-C', current.root, 'merge-base', '--is-ancestor', base, current.head]);
    if (ancestor.code !== 0) throw new Error('Base must be an ancestor of candidate');
    return new LocalWorkflow({ flowType, repository: await realpath(current.root), branch: current.branch, base,
      stage: 'durable-contracts', contracts: [], implementation: null, validationHead: null, receipts: [] });
  }
  snapshot(): WorkflowSnapshot { return structuredClone(this.state); }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Workflow operation in progress');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
  private async candidate(): Promise<string> {
    const current = await new GitAdapter(this.state.repository).inspect();
    if (await realpath(current.root) !== this.state.repository || current.branch !== this.state.branch || current.dirty) throw new Error('Candidate changed or is dirty');
    const ancestor = await runProcess('git', ['-C', this.state.repository, 'merge-base', '--is-ancestor', this.state.base, current.head]);
    if (ancestor.code !== 0) throw new Error('Candidate no longer descends from base');
    return current.head;
  }
  private async contractFile(path: string): Promise<string> {
    if (!nonempty(path) || isAbsolute(path)) throw new Error('Contract paths must be repository-relative');
    const actual = await realpath(resolve(this.state.repository, path));
    const rel = relative(this.state.repository, actual);
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Contract escapes repository');
    return digest(await readFile(actual));
  }
  private async checkContracts(): Promise<void> {
    for (const item of this.state.contracts) for (const file of item.files) {
      if (await this.contractFile(file.path) !== file.digest) throw new Error('Contract changed; settle contracts again');
    }
  }
  /** Caller settles design decisions; references record evidence, never invent approval. */
  async settleContracts(decisions: ContractDecision[]): Promise<WorkflowSnapshot> {
    return this.exclusive(async () => {
      await this.candidate();
      if (!Array.isArray(decisions) || decisions.length !== 2 || decisions.some(d => !d) || new Set(decisions.map(d => d.kind)).size !== 2) throw new Error('Spec and ADR dispositions required');
      const contracts: WorkflowSnapshot['contracts'] = [];
      for (const decision of structuredClone(decisions)) {
        if (!['spec', 'adr'].includes(decision.kind) || !['link', 'not-needed'].includes(decision.disposition) || !nonempty(decision.reason) || !Array.isArray(decision.paths) || decision.paths.some(p => !nonempty(p))) throw new Error('Invalid contract disposition');
        if ((decision.disposition === 'link') !== (decision.paths.length > 0)) throw new Error('Linked contracts require paths; not-needed requires none');
        const files = [];
        for (const path of decision.paths) files.push({ path, digest: await this.contractFile(path) });
        contracts.push({ decision, files });
      }
      this.state.contracts = contracts; this.state.implementation = null;
      this.state.validationHead = null; this.state.receipts = []; this.state.stage = 'delivery-slices';
      return this.snapshot();
    });
  }
  async recordImplementation(detail: string): Promise<WorkflowSnapshot> {
    return this.exclusive(async () => {
      if (this.state.stage !== 'delivery-slices') throw new Error('Settle contracts before implementation');
      if (!nonempty(detail)) throw new Error('Implementation evidence required');
      await this.candidate(); await this.checkContracts();
      this.state.implementation = detail; this.state.stage = 'validation';
      return this.snapshot();
    });
  }
  /** Explicit commands only, without shell expansion. New calls rerun the suite. */
  async validate(entries: ValidationEntry[], signal?: AbortSignal): Promise<WorkflowSnapshot> {
    return this.exclusive(async () => {
      if (!this.state.implementation || !['validation', 'can-open-pr'].includes(this.state.stage)) throw new Error('Implementation evidence required before validation');
      if (!Array.isArray(entries) || entries.length === 0) throw new Error('Validation entries required');
      const suite = structuredClone(entries), ids = new Set<string>();
      for (const entry of suite) {
        if (!entry || !nonempty(entry.id) || ids.has(entry.id) || !nonempty(entry.command) || !Array.isArray(entry.args) || entry.args.some(a => typeof a !== 'string') || (entry.required !== undefined && typeof entry.required !== 'boolean')) throw new Error('Invalid or duplicate validation entry');
        ids.add(entry.id);
        if ((entry.timeoutMs !== undefined && (!Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs < 1 || entry.timeoutMs > 1_800_000)) || (entry.maxOutputBytes !== undefined && (!Number.isSafeInteger(entry.maxOutputBytes) || entry.maxOutputBytes < 1 || entry.maxOutputBytes > 64 * 1024 * 1024))) throw new Error('Invalid validation limits');
      }
      this.state.stage = 'validation'; this.state.validationHead = null; this.state.receipts = [];
      const head = await this.candidate();
      try { await this.checkContracts(); }
      catch (error) { this.state.stage = 'durable-contracts'; throw error; }
      for (const entry of suite) {
        if (signal?.aborted) break;
        const startedAt = new Date().toISOString();
        let code: number | null = null, childSignal: NodeJS.Signals | null = null;
        let stdout = '', stderr = '', error: string | null = null;
        let status: ValidationReceipt['status'] = 'failed';
        try {
          if (await this.candidate() !== head) throw new Error('Candidate moved during validation');
          const result = await runProcess(entry.command, entry.args, {
            cwd: this.state.repository, timeoutMs: entry.timeoutMs ?? 30_000,
            maxOutputBytes: entry.maxOutputBytes ?? 1024 * 1024, ...(signal ? { signal } : {}),
          });
          ({ code, stdout, stderr } = result); childSignal = result.signal;
          status = code === 0 && childSignal === null ? 'passed' : 'failed';
        } catch (cause) {
          error = cause instanceof Error ? cause.message : 'Validation execution failed';
          status = signal?.aborted ? 'interrupted' : 'failed';
        }
        let candidateUnchanged = false;
        try { candidateUnchanged = await this.candidate() === head; await this.checkContracts(); }
        catch { candidateUnchanged = false; }
        if (!candidateUnchanged) { status = 'failed'; error = 'Candidate or contracts changed during validation'; }
        this.state.receipts.push({ id: randomUUID(), entry, repository: this.state.repository,
          base: this.state.base, head, startedAt, finishedAt: new Date().toISOString(), status,
          code, signal: childSignal, stdout, stderr, error, outputDigest: digest(JSON.stringify([stdout, stderr])), candidateUnchanged });
        if (!candidateUnchanged || signal?.aborted) break;
      }
      const required = suite.filter(entry => entry.required !== false);
      if (required.length > 0 && this.state.receipts.length === suite.length && this.state.receipts.every(receipt => receipt.candidateUnchanged) && required.every(entry => this.state.receipts.some(receipt => receipt.entry.id === entry.id && receipt.status === 'passed'))) {
        this.state.validationHead = head; this.state.stage = 'can-open-pr';
      }
      return this.snapshot();
    });
  }
  async readiness(): Promise<{ ready: boolean; firstUnfinishedGate: LocalStage; reason: string | null }> {
    return this.exclusive(async () => {
      if (this.state.stage !== 'can-open-pr') return { ready: false, firstUnfinishedGate: this.state.stage, reason: null };
      try {
        if (await this.candidate() !== this.state.validationHead) throw new Error('Validation HEAD is stale');
        try { await this.checkContracts(); }
        catch (error) {
          this.state.stage = 'durable-contracts'; this.state.validationHead = null;
          return { ready: false, firstUnfinishedGate: 'durable-contracts', reason: error instanceof Error ? error.message : 'Contract unavailable' };
        }
        return { ready: true, firstUnfinishedGate: 'can-open-pr', reason: null };
      } catch (error) {
        this.state.stage = 'validation'; this.state.validationHead = null;
        return { ready: false, firstUnfinishedGate: 'validation', reason: error instanceof Error ? error.message : 'Candidate unavailable' };
      }
    });
  }
}
