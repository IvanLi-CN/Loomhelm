import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tryLockFile } from "../../bin/modules/core/security_file";
import { apply, type requestSchema } from "./engine";
import type { z } from "zod";
import { ContractError } from "./errors";
import { validateLedger } from "./schema";
import type { LedgerStore } from "./store";
import { sendCodexMessage, type CodexDeliveryResult } from "./codex-agent-api";

type Request = z.infer<typeof requestSchema>;
function flightLock(store: LedgerStore, notificationId: string) {
  // Separate from the short ledger lock: held across the provider await. OS
  // process death releases it, leaving the durable unknown intent to reconcile.
  store.read();
  const key = createHash("sha256").update(notificationId).digest("hex");
  const lock = tryLockFile(join(store.runPath, "locks", `notification-${key}.lock`));
  if (!lock) throw new ContractError("NOTIFICATION_IN_FLIGHT", "An active sender still owns this notification; do not reconcile or retry", 5);
  return lock;
}

export function reconcileNotification(store: LedgerStore, parsed: Request): unknown {
  const lock = flightLock(store, String(parsed.payload.notification_id));
  try { return store.update(raw => apply(raw, "notification-reconcile", parsed)); }
  finally { lock.release(); }
}

/** Preserve caller identity, atomic CAS and contract2 states without converting
 * the ledger. A distinct flight lock excludes reconciliation while sending. */
export async function deliverClaimedNotification(
  store: LedgerStore,
  parsed: Request,
  notificationId: string,
  prompt: string,
  send: typeof sendCodexMessage = sendCodexMessage,
  direct = true,
): Promise<unknown> {
  const requestId = direct ? parsed.request_id : `notification-auto-${createHash("sha256").update(JSON.stringify([parsed.run_id, parsed.actor, parsed.request_id, notificationId])).digest("hex")}`;
  function claim(raw: any, replayOnly: boolean): any {
    const ledger = validateLedger(raw);
    const prior = ledger.requests.find(item => item.request_id === requestId);
    if (!prior && replayOnly) return null;
    const attemptId = prior ? (prior.result as any).delivery_attempt_id : randomUUID();
    const result: any = apply(raw, "notification-deliver", {
      run_id: parsed.run_id, actor: parsed.actor, request_id: requestId,
      expected_revision: direct ? parsed.expected_revision : ledger.revision,
      payload: { notification_id: notificationId, delivery_attempt_id: attemptId, outcome: "unknown",
        provider_receipt: { provider: "codex-app-server", evidence_ref: `codex-app-server:${attemptId}:intent` } },
    });
    if (result.code === "REPLAYED") {
      const final = ledger.requests.find(item => item.request_id === `notification-result-${attemptId}`);
      // Return the immutable result of THIS attempt, even if a later request
      // retried it or acknowledged the notification. Never invoke the provider.
      return { replay: final ? { ok: true, code: "APPLIED", revision: final.committed_revision, result: final.result, replayed: true } : { ...result, replayed: true, next_action: "notification-reconcile" } };
    }
    const notice = validateLedger(raw).notifications.find(item => item.id === notificationId)!;
    return { attemptId, notice };
  }
  // Validate cached identity/actor under the ledger lock even during an active
  // send. A repeated caller can observe its original unknown intent safely.
  // Never use update for this read: it normalizes historical records on commit,
  // even when no request exists and the later CAS must reject without writing.
  const cached: any = claim(store.read(), true);
  if (cached) return cached.replay;
  const lock = flightLock(store, notificationId);
  try {
    const claimed: any = store.update(raw => claim(raw, false));
    if (claimed.replay) return claimed.replay;
    const { attemptId, notice } = claimed;
    let delivery: CodexDeliveryResult;
    try {
      delivery = await send({ recipient_thread_id: notice.recipient_thread_id, prompt, request_id: attemptId });
    } catch (error) {
      throw new ContractError("RECONCILIATION_REQUIRED", `Notification attempt ${attemptId} remains unknown: ${String(error)}`, 5);
    }
    return store.update(raw => {
      const current = validateLedger(raw);
      const active = current.notifications.find(item => item.id === notice.id);
      if (!active || active.last_attempt_id !== attemptId || active.delivery_status !== "unknown" || active.last_reconciliation_id !== null)
        throw new ContractError("RECONCILIATION_REQUIRED", `Delivery receipt for ${attemptId} cannot overwrite a changed notification; reconcile ${delivery.provider_receipt.evidence_ref}`, 5);
      return apply(raw, "notification-reconcile", {
        run_id: parsed.run_id, actor: parsed.actor,
        request_id: `notification-result-${attemptId}`, expected_revision: current.revision,
        payload: { notification_id: notice.id, reconciliation_id: `result-${attemptId}`,
          outcome: delivery.outcome, provider_receipt: delivery.provider_receipt,
          ...(delivery.error ? { error: delivery.error } : {}) },
      });
    });
  } finally { lock.release(); }
}

/** Claim once, release the OS lock, then let the caller use the desktop tool.
 * An unknown durable attempt excludes every other sender until reconciliation. */
export function prepareNativeNotification(
  store: LedgerStore, parsed: Request, notificationId: string, prompt: string, direct = true,
): unknown {
  const requestId = direct ? parsed.request_id : `notification-native-${createHash("sha256").update(JSON.stringify([parsed.run_id, parsed.actor, parsed.request_id, notificationId])).digest("hex")}`;
  const lock = flightLock(store, notificationId);
  try {
    return store.update(raw => {
      const ledger = validateLedger(raw);
      const prior = ledger.requests.find(item => item.request_id === requestId);
      const attemptId = prior ? (prior.result as any).delivery_attempt_id : randomUUID();
      const notice = ledger.notifications.find(item => item.id === notificationId)!;
      const promptDigest = createHash("sha256").update(prompt).digest("hex");
      const result: any = apply(raw, "notification-deliver", {
        run_id: parsed.run_id, actor: parsed.actor, request_id: requestId,
        expected_revision: direct ? parsed.expected_revision : ledger.revision,
        payload: { notification_id: notificationId, delivery_attempt_id: attemptId, outcome: "unknown", prompt_digest: promptDigest,
        provider_receipt: { provider: "codex-app-tools", evidence_ref: `codex-app-tools:${attemptId}:intent`, recipient_thread_id: notice.recipient_thread_id, prompt_digest: promptDigest } },
      });
      return { ...result, replayed: result.code === "REPLAYED", delivery_attempt_id: attemptId, should_send: result.code !== "REPLAYED",
        next_action: result.code === "REPLAYED" ? "notification-reconcile" : "send_message_to_thread",
        tool_request: result.code === "REPLAYED" ? null : { threadId: notice.recipient_thread_id, prompt },
        receipt_command: "notification-reconcile",
        receipt_identity: { notification_id: notificationId, delivery_attempt_id: attemptId, recipient_thread_id: notice.recipient_thread_id, prompt_digest: promptDigest } };
    });
  } finally { lock.release(); }
}
