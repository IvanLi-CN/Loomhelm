import { expect, test } from "bun:test";
import { taskDispatchEligibility } from "../lib/dispatch-eligibility";
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
  test(`dispatch is independent of a ${status} ready notification`, () => {
    const ledger = fixture(status);
    expect(
      taskDispatchEligibility(ledger, ledger.tasks.find((t) => t.id === "task-a")!).allowed,
    ).toBe(true);
    expect(
      apply(
        ledger,
        "dispatch-claim",
        request(ledger, "claim", { task_id: "task-a", operation_id: "dispatch" }),
      ),
    ).toMatchObject({ code: "APPLIED" });
    expect(ledger.notifications.find((n) => n.id === "ready-notice")?.delivery_status).toBe(status);
  });
}
test("only the recipient can acknowledge, even when acknowledgement is optional", () => {
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
  expect(
    apply(
      stale,
      "dispatch-claim",
      request(stale, "claim", { task_id: "task-a", operation_id: "dispatch" }),
    ),
  ).toMatchObject({ code: "APPLIED" });
  expect(
    apply(
      ledger,
      "dispatch-claim",
      request(ledger, "claim", { task_id: "task-a", operation_id: "dispatch" }),
    ),
  ).toMatchObject({ code: "APPLIED" });
});

test("a pending claim uses capacity without blocking an unrelated task", () => {
  const ledger = fixture("unknown");
  const a = ledger.tasks.find((task) => task.id === "task-a")!;
  const b = () => ledger.tasks.find((task) => task.id === "task-b")!;
  ledger.config.max_running_tasks = 1;
  apply(
    ledger,
    "dispatch-claim",
    request(ledger, "first", { task_id: a.id, operation_id: "op-a" }),
  );
  expect(
    taskDispatchEligibility(ledger, ledger.tasks.find((task) => task.id === a.id)!),
  ).toMatchObject({ allowed: false, blocker: { code: "OPERATION_PENDING" } });
  expect(taskDispatchEligibility(ledger, b())).toMatchObject({
    allowed: false,
    blocker: { code: "CAPACITY" },
  });
  ledger.config.max_running_tasks = 2;
  expect(taskDispatchEligibility(ledger, b()).allowed).toBe(true);
});
