import type { CommandContext } from "./engine-command-context";
import { find, now, onlyMain, stable, string } from "./engine-support-core";
import { addEvent } from "./engine-support-gates";
import { requireCondition } from "./errors";
import { recoveryAttempt } from "./initialization-recovery-attempt";

export const initializationRecoveryCommands = [
  "initialization-recovery-claim",
  "initialization-recovery-observe",
] as const;
export function executeInitializationRecoveryCommand({
  ledger,
  command,
  request,
  payload,
}: CommandContext): unknown {
  onlyMain(request.actor);
  const op = find(
    ledger.operations,
    (item) => item.kind === "dispatch" && item.id === string(payload.operation_id),
    "Dispatch",
  );
  requireCondition(
    op.status === "unknown" && (op.request.creation_parameters as any)?.transport === "codex-exec",
    "RECOVERY_NOT_ALLOWED",
    "Recovery requires an unknown CLI creation",
    5,
  );
  if (command === "initialization-recovery-observe") {
    const attempt = recoveryAttempt.parse(op.request.initialization_recovery);
    const turnId = string(payload.turn_id);
    requireCondition(
      attempt.attempt_id === payload.attempt_id &&
        turnId !== attempt.original_turn_id &&
        (!attempt.recovery_turn_id || attempt.recovery_turn_id === turnId),
      "RECOVERY_IDENTITY_CONFLICT",
      "Recovery turn identity changed",
      5,
    );
    op.request.initialization_recovery = { ...attempt, recovery_turn_id: turnId };
    op.updated_at = now();
    addEvent(ledger, request, "dispatch_thread_observed", op.target_id, {
      operation_id: op.id,
      thread_id: attempt.thread_id,
      initialization_recovery: { attempt_id: attempt.attempt_id, turn_id: turnId },
    });
    return { operation_id: op.id, turn_id: turnId };
  }
  const attempt = recoveryAttempt.omit({ recovery_turn_id: true }).parse(payload.attempt);
  requireCondition(
    !op.request.initialization_recovery,
    "RECOVERY_ALREADY_CLAIMED",
    "Recovery is already claimed; reconcile without resending",
    5,
  );
  requireCondition(
    attempt.native_request_id === op.request.native_request_id &&
      attempt.thread_id === op.request.observed_thread_id &&
      stable(attempt.execution_profile) === stable(op.request.execution_profile),
    "RECOVERY_IDENTITY_CONFLICT",
    "Recovery identity or execution profile changed",
    5,
  );
  requireCondition(
    !ledger.operations.some(
      (item) => (item.request.initialization_recovery as any)?.attempt_id === attempt.attempt_id,
    ),
    "RECOVERY_IDENTITY_CONFLICT",
    "Recovery attempt identity is already used",
    5,
  );
  op.request.initialization_recovery = attempt;
  op.updated_at = now();
  addEvent(ledger, request, "dispatch_request_bound", op.target_id, {
    operation_id: op.id,
    native_request_id: attempt.native_request_id,
    initialization_recovery: attempt,
  });
  return { operation_id: op.id, attempt_id: attempt.attempt_id };
}
