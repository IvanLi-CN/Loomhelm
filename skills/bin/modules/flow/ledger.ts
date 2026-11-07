import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { FlowError, isoNow } from "./common";
import {
  bindPr,
  initFlow,
  recordConvergence,
  registerAcceptanceManifest,
} from "./ledger-lifecycle";
import {
  assessReviewNecessity,
  authorizeRepair,
  finalizeReviewWave,
  openReviewWave,
  recordSubagentReview,
} from "./ledger-review";
import { reopenConvergence } from "./ledger-reopen";
import { recordPhaseAcceptance, recordPostMerge } from "./ledger-acceptance";
import { recordValidation, runValidation } from "./ledger-validation";
import { recordAttestation } from "./ledger-attestation";
import { classifyGitDelta, closeFlow, status } from "./ledger-terminal";
import { ReceiptStorage } from "./receipt-storage";
import { type ValidationOptions } from "./validation";
import { gitLedgerRoot } from "./git";

export class FlowLedger extends ReceiptStorage {
  readonly repo: string | undefined;
  private readonly lifecycleContext = new AsyncLocalStorage<FlowLedger>();

  constructor(root: string, repo?: string) {
    super(root);
    this.repo = repo ? resolve(repo) : undefined;
  }

  override withLifecycleLock<T>(callback: () => T, timeoutMs = 30_000): T {
    if (this.lifecycleContext.getStore() === this) return callback();
    return super.withLifecycleLock(
      () => this.lifecycleContext.run(this, callback),
      timeoutMs,
    );
  }

  override withLifecycleLockAsync<T>(
    callback: () => Promise<T>,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.lifecycleContext.getStore() === this) return callback();
    return super.withLifecycleLockAsync(
      () => this.lifecycleContext.run(this, callback),
      timeoutMs,
    );
  }

  activeUpdate<T>(callback: (ledger: Record<string, unknown>) => T): T {
    return this.withLifecycleLock(() => this.activeUpdateLocked(callback));
  }

  activeUpdateLocked<T>(callback: (ledger: Record<string, unknown>) => T): T {
    return this.withLock(() => {
      const ledger = this.read();
      if (ledger.state !== "active")
        throw new FlowError(
          `flow receipt ledger is terminal: ${String(ledger.state)}`,
        );
      const result = callback(ledger);
      ledger.updated_at = isoNow();
      this.write(ledger);
      return result;
    });
  }

  init(
    runId: string | undefined,
    flowType: string,
    baseSha: string,
    headSha: string,
    prRef?: string,
    manifestFile?: string,
  ): Record<string, unknown> {
    return this.withLifecycleLock(() =>
      initFlow(this, runId, flowType, baseSha, headSha, prRef, manifestFile),
    );
  }

  registerAcceptanceManifest(file: string): Record<string, unknown> {
    return this.withLifecycleLock(() => registerAcceptanceManifest(this, file));
  }

  bindPr(prRef: string): Record<string, unknown> {
    return this.withLifecycleLock(() => bindPr(this, prRef));
  }

  assessReviewNecessity(tier: number, reason: string): Record<string, unknown> {
    return this.withLifecycleLock(() =>
      assessReviewNecessity(this, tier, reason),
    );
  }

  openReviewWave(options: {
    stage: string;
    baseRef: string;
    headSha?: string | undefined;
    laneSpecs: { lane: string; model: string; effort: string }[];
    scopeClass?: string | undefined;
    previousHeadSha?: string | undefined;
    repairPermitId?: string | undefined;
    highRequirement?: boolean | undefined;
    arbitrationConflicts?: string[] | undefined;
    arbitrationBlockerFingerprints?: string[] | undefined;
  }): Record<string, unknown> {
    return this.withLifecycleLock(() => openReviewWave(this, options));
  }

  recordSubagentReview(
    options: Parameters<typeof recordSubagentReview>[1],
  ): Record<string, unknown> {
    return this.withLifecycleLock(() => recordSubagentReview(this, options));
  }

  finalizeReviewWave(
    waveId: string,
    synthesis: unknown,
  ): Record<string, unknown> {
    return this.withLifecycleLock(() =>
      finalizeReviewWave(this, waveId, synthesis),
    );
  }

  authorizeRepair(waveId: string): Record<string, unknown> {
    return this.withLifecycleLock(() => authorizeRepair(this, waveId));
  }

  reopenConvergence(
    options: Parameters<typeof reopenConvergence>[1],
  ): Record<string, unknown> {
    return reopenConvergence(this, options);
  }

  recordValidation(options: ValidationOptions): Record<string, unknown> {
    return recordValidation(this, options);
  }

  runValidation(
    command: string,
    toolchainFingerprint: string,
    inputFingerprint: string,
    options: {
      headSha?: string | undefined;
      logPath?: string | undefined;
      retryStateFingerprint?: string | undefined;
      inputPaths?: string[] | undefined;
      acceptanceEvidence?: unknown;
    } = {},
  ): Promise<Record<string, unknown>> {
    return runValidation(
      this,
      command,
      toolchainFingerprint,
      inputFingerprint,
      options,
    );
  }

  recordPostMerge(evidence: unknown): Record<string, unknown> {
    return this.withLifecycleLock(() => recordPostMerge(this, evidence));
  }

  recordPhaseAcceptance(
    evidence: unknown,
    mergeSha: string,
    deploymentIdentity?: unknown,
  ): Record<string, unknown> {
    return this.withLifecycleLock(() =>
      recordPhaseAcceptance(this, evidence, mergeSha, deploymentIdentity),
    );
  }

  recordAttestation(
    sourceReceiptId: string,
    headSha: string,
    baseRef: string,
  ): Record<string, unknown> {
    return recordAttestation(this, sourceReceiptId, headSha, baseRef);
  }

  recordConvergence(blockers: string[]): Record<string, unknown> {
    return recordConvergence(this, blockers);
  }

  classifyGitDelta(
    sourceHead: string,
    targetHead: string,
    requireCurrent = false,
  ): Record<string, unknown> {
    return classifyGitDelta(this, sourceHead, targetHead, requireCurrent);
  }

  status(): Record<string, unknown> {
    return status(this);
  }

  close(state: string): Record<string, unknown> {
    return closeFlow(this, state);
  }
}

export { gitLedgerRoot };
