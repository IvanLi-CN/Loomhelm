import type { Ledger } from "../lib/schema";
import { ContractError, requireCondition } from "../lib/errors";

export const terminal = (task: Ledger["tasks"][number]) =>
  ["completed", "closed"].includes(task.state) || ["abandoned", "superseded"].includes(task.disposition);

export function requireArchiveEligibility(ledger: Ledger, taskId: string): string {
  const task = ledger.tasks.find(task => task.id === taskId);
  requireCondition(task?.thread_id && terminal(task), "TASK_NOT_TERMINAL", "Task is not ready for conversation archive", 4);
  const thread = task.thread_id;
  requireCondition(thread !== ledger.control.owner_thread_id && !ledger.groups.some(group => group.agent_thread_id === thread), "SHARED_CONVERSATION", "Coordinator conversations cannot be archived as child tasks", 4);
  requireCondition(!ledger.tasks.some(other => other.thread_id === thread && !terminal(other)), "SHARED_CONVERSATION", "Another task still uses this conversation", 4);
  const boundOperation = (op: Ledger["operations"][number]) => {
    const request = op.request as Record<string, unknown>;
    return op.target_id === taskId || request.task_id === taskId || request.thread_id === thread;
  };
  requireCondition(!ledger.operations.some(op => boundOperation(op) && ["claimed", "unknown"].includes(op.status)), "OPERATIONS_PENDING", "Unresolved task operations prevent conversation archive", 4);
  requireCondition(!ledger.follow_prs.some(pr => pr.origin_task_id === taskId && pr.state !== "merged"), "FOLLOW_PR_PENDING", "Follow PR is not merged", 4);
  requireCondition(!ledger.notifications.some(notice => {
    const event = ledger.events.find(event => event.id === notice.event_id);
    return (notice.recipient_thread_id === thread || event?.subject_id === taskId || event?.data.task_id === taskId) && notice.ack_status !== "acknowledged";
  }), "NOTIFICATIONS_PENDING", "Task notifications must be acknowledged before archive", 4);
  return thread;
}

export function conversationArchiveEligibility(ledger: Ledger, taskId: string) {
  try { requireArchiveEligibility(ledger, taskId); return { eligible: true, reason: null }; }
  catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return { eligible: false, reason: error.message };
  }
}
