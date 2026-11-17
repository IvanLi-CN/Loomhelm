import { expect, test } from "bun:test";
import { apply } from "../lib/engine";
import { notification } from "../lib/schema";
import { modernFixture, request } from "./role-flow-fixtures";

const at = "2026-01-01T00:00:00.000Z";
function fixture(status: "pending" | "failed" | "sent" | "unknown") {
  const ledger = modernFixture();
  ledger.events.push({
    id: "ready",
    type: "task_ready",
    subject_id: ledger.orchestration_id,
    actor_id: ledger.control.owner_thread_id,
    occurred_at: at,
    recorded_at: at,
    data: { task_ids: ["task-a"] },
  });
  ledger.notifications.push(
    notification.parse({
      id: "ready-notice",
      event_id: "ready",
      recipient_thread_id: ledger.control.owner_thread_id,
      ledger_status: "committed",
      status,
      delivery_status: status,
      ack_status: "unacknowledged",
      attempts: 0,
      last_attempt_id: null,
      last_reconciliation_id: null,
      last_error: null,
      updated_at: at,
    }),
  );
  return ledger;
}
for (const status of ["pending", "failed", "sent", "unknown"] as const) {
  test(`dispatch rejects ${status} task-ready notification without recipient acknowledgement`, () => {
    const ledger = fixture(status);
    const before = JSON.stringify(ledger);
    expect(() =>
      apply(
        ledger,
        "dispatch-claim",
        request(ledger, "claim", { task_id: "task-a", operation_id: "dispatch" }),
      ),
    ).toThrow("requires recipient acknowledgement");
    expect(JSON.stringify(ledger)).toBe(before);
  });
}
test("only the current ready generation and owner acknowledgement release dispatch", () => {
  const ledger = fixture("sent");
  expect(() =>
    apply(
      ledger,
      "notification-ack",
      request(
        ledger,
        "foreign-ack",
        { notification_id: "ready-notice", handling_evidence: "handled" },
        { role: "group", thread_id: "delivery-thread" },
      ),
    ),
  ).toThrow("Only the recipient");
  apply(
    ledger,
    "notification-ack",
    request(ledger, "ack", { notification_id: "ready-notice", handling_evidence: "handled" }),
  );
  const stale = structuredClone(ledger);
  stale.events.push({ ...stale.events.find((e) => e.id === "ready")!, id: "ready-new" });
  expect(() =>
    apply(
      stale,
      "dispatch-claim",
      request(stale, "claim", { task_id: "task-a", operation_id: "dispatch" }),
    ),
  ).toThrow("requires recipient acknowledgement");
  expect(
    apply(
      ledger,
      "dispatch-claim",
      request(ledger, "claim", { task_id: "task-a", operation_id: "dispatch" }),
    ),
  ).toMatchObject({ code: "APPLIED" });
});
