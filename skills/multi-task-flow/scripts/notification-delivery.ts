import { randomUUID } from "node:crypto";
import { apply, type requestSchema } from "./engine";
import type { z } from "zod";
import { ContractError } from "./errors";
import { validateLedger } from "./schema";
import type { LedgerStore } from "./store";
import { sendCodexMessage, type CodexDeliveryResult } from "./codex-agent-api";

/** Persist uncertainty before crossing the provider boundary. Uses only the
 * existing contract2 delivery/reconciliation states and the original lock. */
export async function deliverClaimedNotification(
  store: LedgerStore,
  parsed: z.infer<typeof requestSchema>,
  notificationId: string,
  prompt: string,
  send: typeof sendCodexMessage = sendCodexMessage,
): Promise<unknown> {
  const ledger = validateLedger(store.read());
  const notice = ledger.notifications.find(item => item.id === notificationId);
  if (!notice) throw new ContractError("NOT_FOUND", "Notification not found");
  if (notice.delivery_status === "unknown") return { notification_id: notice.id, delivery_status: "unknown", next_action: "notification-reconcile" };
  if (["sent", "acknowledged"].includes(notice.status)) return { notification_id: notice.id, delivery_status: notice.delivery_status, ack_status: notice.ack_status, replayed: true };
  const attemptId = randomUUID();
  // The locked mutation checks sender authorization, current revision and
  // delivery state before any socket is opened. A crash now leaves unknown,
  // never pending; another process cannot claim or resend it.
  store.update(raw => apply(raw, "notification-deliver", {
    run_id: parsed.run_id, actor: parsed.actor,
    request_id: `notification-claim-${attemptId}`, expected_revision: ledger.revision,
    payload: {
      notification_id: notice.id, delivery_attempt_id: attemptId, outcome: "unknown",
      provider_receipt: { provider: "codex-app-server", evidence_ref: `codex-app-server:${attemptId}:intent` },
    },
  }));
  let delivery: CodexDeliveryResult;
  try {
    delivery = await send({ recipient_thread_id: notice.recipient_thread_id, prompt, request_id: attemptId });
  } catch (error) {
    // Unexpected adapter failure has no trustworthy non-delivery receipt.
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
      payload: {
        notification_id: notice.id, reconciliation_id: `result-${attemptId}`,
        outcome: delivery.outcome, provider_receipt: delivery.provider_receipt,
        ...(delivery.error ? { error: delivery.error } : {}),
      },
    });
  });
}
