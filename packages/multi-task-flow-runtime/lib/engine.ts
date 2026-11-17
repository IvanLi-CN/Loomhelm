import { ContractError, requireCondition } from "../lib/errors";
import type { Ledger } from "../lib/schema";
import { validateLedger } from "../lib/schema";
import { closeoutCommands, executeCloseoutCommand } from "./engine-closeout";
import { type CommandDomain, indexCommandDomains } from "./engine-command-context";
import { coordinationCommands, executeCoordinationCommand } from "./engine-coordination";
import {
  evidenceDeliveryCommands,
  executeEvidenceDeliveryCommand,
} from "./engine-evidence-delivery";
import { executeExecutionCommand, executionCommands } from "./engine-execution";
import { executeGroupLifecycleCommand, groupLifecycleCommands } from "./engine-group-lifecycle";
import { executeMergeCutCommand, mergeCutCommands } from "./engine-merge-cut";
import type { Request } from "./engine-support-core";
import * as core from "./engine-support-core";
import { actorSchema, authorize, now, requestSchema, stable } from "./engine-support-core";
import * as support from "./engine-support-gates";
import {
  addEvent,
  addNotificationIntent,
  notificationDeliveryRequest,
  notificationDirective,
  ready,
} from "./engine-support-gates";
import { executeTaskIntegrationCommand, taskIntegrationCommands } from "./engine-task-integration";
import { executeTaskLifecycleCommand, taskLifecycleCommands } from "./engine-task-lifecycle";
import {
  executeWorkspacePublicationCommand,
  workspacePublicationCommands,
} from "./engine-workspace-publication";

export type { Request };
export { actorSchema, requestSchema };

export const parentPrReady = core.parentPrReady;
export const deliveryUnitPrMerged = support.deliveryUnitPrMerged;
export const requireGroupDispatchGate = support.requireGroupDispatchGate;
export { authorize, ready };

const domains: CommandDomain[] = [
  { commands: coordinationCommands, handle: executeCoordinationCommand },
  { commands: executionCommands, handle: executeExecutionCommand },
  { commands: taskLifecycleCommands, handle: executeTaskLifecycleCommand },
  { commands: groupLifecycleCommands, handle: executeGroupLifecycleCommand },
  { commands: workspacePublicationCommands, handle: executeWorkspacePublicationCommand },
  { commands: taskIntegrationCommands, handle: executeTaskIntegrationCommand },
  { commands: mergeCutCommands, handle: executeMergeCutCommand },
  { commands: evidenceDeliveryCommands, handle: executeEvidenceDeliveryCommand },
  { commands: closeoutCommands, handle: executeCloseoutCommand },
];
const commandHandlers = indexCommandDomains(domains);

export function execute(ledger: Ledger, command: string, request: Request): unknown {
  if (command !== "binding-resolve") authorize(ledger, request.actor);
  const context = {
    ledger,
    command,
    request,
    payload: request.payload,
    currentPlan: () => core.approved(ledger),
  };
  const handler = commandHandlers.get(command);
  if (handler) {
    const result = handler(context);
    if (result !== undefined) return result;
    throw new ContractError("COMMAND_HANDLER_MISSING", `Command domain did not handle: ${command}`);
  }
  throw new ContractError("UNKNOWN_COMMAND", `Unsupported command: ${command}`);
}

export function apply(ledger: Ledger, command: string, request: Request): unknown {
  const normalized = validateLedger(ledger);
  if ((ledger as any).schema_version === 1) Object.assign(ledger, structuredClone(normalized));
  requireCondition(
    request.run_id === ledger.orchestration_id,
    "RUN_MISMATCH",
    "Request refers to another run",
    3,
  );
  if (command !== "binding-resolve") authorize(ledger, request.actor);
  const canonical = stable({
    run_id: request.run_id,
    actor: request.actor,
    command,
    payload: request.payload,
  });
  const prior = ledger.requests.find((item) => item.request_id === request.request_id);
  if (prior) {
    requireCondition(
      prior.command === command && prior.canonical_input === canonical,
      "ID_CONFLICT",
      "Request ID has different content",
      3,
    );
    return {
      ok: true,
      code: "REPLAYED",
      revision: prior.committed_revision,
      result: prior.result,
    };
  }
  requireCondition(
    ledger.revision === request.expected_revision,
    "REVISION_CONFLICT",
    "Ledger version changed",
    3,
  );
  requireCondition(
    !!normalized.config.execution_profile || command === "execution-profile-migrate",
    "PROFILE_MIGRATION_REQUIRED",
    "Run is read-only until explicit execution-profile-migrate",
    4,
  );
  const candidate = structuredClone(normalized);
  const readinessCommands = new Set([
    "atom-update",
    "task-update",
    "merge-resolve",
    "group-base-reconcile",
    "lifecycle-record",
    "milestone-record",
    "fact-record",
    "task-equivalent-integrate",
    "task-external-merge-reconcile",
  ]);
  const readinessBefore = readinessCommands.has(command)
    ? new Map(
        candidate.tasks
          .filter((task) => task.disposition === "active")
          .map((task) => [task.id, ready(candidate, task.id)]),
      )
    : new Map<string, boolean>();
  const result = execute(candidate, command, request);
  const newlyReady = readinessCommands.has(command)
    ? candidate.tasks
        .filter(
          (task) =>
            task.disposition === "active" &&
            task.thread_id === null &&
            !candidate.operations.some(
              (op) => op.kind === "dispatch" && op.target_id === task.id,
            ) &&
            !readinessBefore.get(task.id) &&
            ready(candidate, task.id),
        )
        .map((task) => task.id)
    : [];
  if (newlyReady.length > 0) {
    const eventId = `${request.request_id}-ready`;
    addEvent(
      candidate,
      { ...request, request_id: eventId },
      "task_ready",
      candidate.orchestration_id,
      {
        task_ids: newlyReady,
        trigger_command: command,
        trigger_request_id: request.request_id,
      },
    );
    const notice = notificationDirective(
      candidate,
      request,
      { notification: { mode: "auto", recipient: "owner" } },
      true,
    );
    if (notice.enabled && typeof result === "object" && result !== null && !Array.isArray(result)) {
      const notification = addNotificationIntent(
        candidate,
        { ...request, request_id: eventId },
        notice.recipient_thread_id!,
      );
      Object.assign(result, {
        readiness_notification_id: notification.id,
        readiness_notification_request: notificationDeliveryRequest(notification),
        ready_task_ids: newlyReady,
      });
    }
  }
  candidate.revision += 1;
  candidate.updated_at = now();
  candidate.requests.push({
    request_id: request.request_id,
    command,
    canonical_input: canonical,
    result,
    committed_revision: candidate.revision,
  });
  validateLedger(candidate);
  Object.assign(ledger, candidate);
  return { ok: true, code: "APPLIED", revision: ledger.revision, result };
}
