import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tryLockFile } from "../../../skills/bin/modules/core/security_file";
import { apply } from "../lib/engine";
import { ContractError, requireCondition } from "../lib/errors";
import { validateLedger, type Ledger } from "../lib/schema";
import type { LedgerStore } from "../lib/store";
import { archiveCodexThread, archivedCodexThread, unarchiveCodexThread, unarchivedCodexThread } from "../lib/codex-agent-api";

export type ArchiveProvider = {
  archive: typeof archiveCodexThread;
  isArchived: typeof archivedCodexThread;
  unarchive?: typeof unarchiveCodexThread;
  isUnarchived?: typeof unarchivedCodexThread;
};
const provider: ArchiveProvider = { archive: archiveCodexThread, isArchived: archivedCodexThread, unarchive: unarchiveCodexThread, isUnarchived: unarchivedCodexThread };
import { terminal, requireArchiveEligibility } from "../lib/conversation-eligibility";

/** One OS lock spans reconciliation, durable intent, provider await and receipt. */
export async function retryConversationArchive(store: LedgerStore, taskId: string, api: ArchiveProvider = provider) {
  return changeConversationArchive(store, taskId, api, true);
}
export async function retryConversationUnarchive(store: LedgerStore, taskId: string, api: ArchiveProvider = provider) {
  return changeConversationArchive(store, taskId, api, false);
}
async function changeConversationArchive(store: LedgerStore, taskId: string, api: ArchiveProvider, archived: boolean) {
  const initial = validateLedger(store.read());
  const boundThread = (ledger: Ledger) => {
    const task = ledger.tasks.find(task => task.id === taskId);
    requireCondition(task?.thread_id, "TASK_NOT_BOUND", "Task has no conversation", 4);
    requireCondition(task.thread_id !== ledger.control.owner_thread_id && !ledger.groups.some(group => group.agent_thread_id === task.thread_id), "SHARED_CONVERSATION", "Coordinator conversations cannot be managed as child tasks", 4);
    return task.thread_id;
  };
  const thread = boundThread(initial);
  const key = createHash("sha256").update(thread).digest("hex");
  const lock = tryLockFile(join(store.runPath, "locks", `archive-${key}.lock`));
  if (!lock) throw new ContractError("ARCHIVE_IN_FLIGHT", "Conversation archive is already in progress", 4);
  try {
    const ledger = validateLedger(store.read());
    requireCondition(boundThread(ledger) === thread, "RESOURCE_MISMATCH", "Conversation binding changed", 4);
    const existing = ledger.resources.find(resource => resource.kind === "conversation" && resource.target === thread);
    if (archived && existing?.status === "closed") return existing;
    if (!archived && existing?.status === "active") return existing;
    requireCondition(archived ? !existing?.status.startsWith("unarchive_") : !!existing && ["closed", "unarchive_failed", "unarchive_unknown"].includes(existing.status), "ARCHIVE_STATE_CONFLICT", "Reconcile the current archive operation before changing its direction", 4);
    if (!archived) requireCondition(api.unarchive && api.isUnarchived, "UNARCHIVE_UNSUPPORTED", "Unarchive is unavailable", 4);
    const unknown = archived ? "archive_unknown" : "unarchive_unknown";
    const failed = archived ? "archive_failed" : "unarchive_failed";
    const complete = archived ? "closed" : "active";
    const operationId = `archive-${randomUUID()}`;
    const resource = existing ?? { id: `conversation-${key.slice(0, 32)}`, kind: "conversation" as const, target: thread, status: "pending" as const, evidence_ref: null };
    let writeSequence = 0;
    const write = (status: "pending" | "closed" | "active" | "archive_failed" | "archive_unknown" | "unarchive_failed" | "unarchive_unknown", error: string | null, evidence: string, claim = false) => {
      store.update(raw => {
        const current = validateLedger(raw);
        // Eligibility and durable intent share the ledger lock with notification claims.
        if (claim && archived) requireArchiveEligibility(current, taskId);
        // Re-prove ownership and exact binding before every write.
        requireCondition(current.tasks.find(task => task.id === taskId)?.thread_id === thread, "RESOURCE_MISMATCH", "Conversation binding changed", 4);
        return apply(raw, "resource-update", {
          run_id: current.orchestration_id,
          actor: { role: "main", thread_id: current.control.owner_thread_id },
          request_id: `${operationId}-${++writeSequence}`,
          expected_revision: current.revision,
          payload: { resource: { ...resource, archive_policy: archived ? "auto" : "manual", status, error, evidence_ref: evidence, operation_id: operationId, last_attempt_at: new Date().toISOString() } },
        });
      });
      return validateLedger(store.read()).resources.find(item => item.id === resource.id)!;
    };
    // Unknown attempts are reconciled first. A negative lookup cannot prove
    // that an earlier request will not complete, so never resend from unknown.
    if (existing?.status === unknown) {
      try {
        if (await (archived ? api.isArchived(thread) : api.isUnarchived!(thread))) return write(complete, null, `codex-app-server:${operationId}:reconciled`);
        return write(unknown, "Archive not confirmed; previous request remains unresolved", `codex-app-server:${operationId}:not-confirmed`);
      } catch (error) {
        return write(unknown, String(error).slice(0, 500), `codex-app-server:${operationId}:lookup-error`);
      }
    }
    if (archived) requireArchiveEligibility(ledger, taskId);
    // Claim before crossing the provider boundary. Process death leaves unknown.
    write(unknown, "Archive attempt is in progress; reconcile after interruption", `codex-app-server:${operationId}:intent`, true);
    let result;
    try { result = await (archived ? api.archive(thread, operationId) : api.unarchive!(thread, operationId)); }
    catch (error) { result = { outcome: "unknown" as const, evidence_ref: `codex-app-server:${operationId}:error`, error: String(error).slice(0, 500) }; }
    return write(result.outcome === "succeeded" ? complete : result.outcome === "failed" ? failed : result.outcome === "deferred" ? "pending" : unknown, result.error ?? null, result.evidence_ref);
  } finally { lock.release(); }
}

export async function sweepConversationArchives(store: LedgerStore, api: ArchiveProvider = provider): Promise<void> {
  const ledger = validateLedger(store.read());
  for (const task of ledger.tasks.filter(terminal)) {
    const resource = ledger.resources.find(resource => resource.kind === "conversation" && resource.target === task.thread_id);
    // Failures and unknowns require the explicit retry/reconcile button.
    if (resource?.archive_policy === "manual" || resource?.status === "closed" || resource?.status === "archive_failed" || resource?.status === "archive_unknown") continue;
    try { await retryConversationArchive(store, task.id, api); }
    catch { /* Eligibility/locks defer work; the next lifecycle trigger revisits it. */ }
  }
}
