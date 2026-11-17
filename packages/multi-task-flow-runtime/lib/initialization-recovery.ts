import { randomUUID } from "node:crypto";
import { verifyWorktree } from "./codex-cli-create";
import {
  type AgentRole,
  initializationRecoveryPrompt,
  verifyInterruptedInitializationTurn,
  verifyRecoveryTurn,
} from "./codex-cli-initialization";
import {
  type RecoveryRpc,
  requireRecoveryCapability,
  withRecoveryWriter,
} from "./codex-recovery-writer";
import { connectSocket, record, rpc, socketPath } from "./codex-rpc";
import { apply, type Request } from "./engine";
import { ContractError } from "./errors";
import {
  type RecoveryAttempt,
  recoveryAttempt,
  recoveryDigest,
} from "./initialization-recovery-attempt";
import { executionProfile, validateLedger } from "./schema";
import type { LedgerStore } from "./store";

export type RecoveryHistory = { thread: Record<string, unknown>; turns: Record<string, unknown>[] };
export async function readRecoveryHistory(
  request: RecoveryRpc,
  threadId: string,
): Promise<RecoveryHistory> {
  const thread = record((await request("thread/read", { threadId, includeTurns: false })).thread);
  const page = await request("thread/turns/list", {
    threadId,
    sortDirection: "asc",
    limit: 3,
    itemsView: "full",
  });
  if (
    !thread ||
    thread.id !== threadId ||
    !Array.isArray(page.data) ||
    page.nextCursor ||
    page.data.length > 2
  )
    throw new Error("Recovery requires complete, bounded thread history");
  const turns = page.data.map(record);
  if (
    turns.some(
      (turn) =>
        !turn ||
        typeof turn.id !== "string" ||
        turn.itemsView !== "full" ||
        !Array.isArray(turn.items),
    )
  )
    throw new Error("Recovery requires full native turn items");
  return { thread, turns: turns as Record<string, unknown>[] };
}
export async function readRecoverySnapshot(threadId: string): Promise<RecoveryHistory> {
  const path = socketPath();
  if (!path) throw new Error("Recovery read control unavailable");
  const { socket, buffer: initial } = await connectSocket(path, 5_000);
  const buffer = { value: initial };
  let sequence = 0;
  const deadline = Date.now() + 10_000;
  const request: RecoveryRpc = async (method, params) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Recovery read deadline exceeded");
    const response = await rpc(socket, buffer, ++sequence, method, params, {
      timeoutMs: remaining,
    });
    if (response.error) throw new Error(`Recovery read rejected: ${method}`);
    return record(response.result) ?? {};
  };
  try {
    await request("initialize", {
      clientInfo: { name: "multi-task-flow-recovery", version: "1" },
      capabilities: { experimentalApi: true },
    });
    return await readRecoveryHistory(request, threadId);
  } finally {
    socket.destroy();
  }
}
export function verifyRecoveryHistory(
  history: RecoveryHistory,
  attempt: RecoveryAttempt,
  source: string,
  role: AgentRole,
  completed: boolean,
  verify = verifyWorktree,
): void {
  const { thread, turns } = history;
  if (
    thread.id !== attempt.thread_id ||
    thread.model !== attempt.execution_profile.model ||
    thread.reasoningEffort !== attempt.execution_profile.thinking ||
    thread.cwd !== attempt.workspace_path
  )
    throw new Error("Recovery thread, workspace or profile mismatch");
  if (!["idle", "notLoaded"].includes(String(record(thread.status)?.type)))
    throw new Error("Recovery thread has an active or unavailable native state");
  if (turns.length !== (completed ? 2 : 1) || turns[0]?.id !== attempt.original_turn_id)
    throw new Error("Recovery history contains an unexpected turn");
  verifyInterruptedInitializationTurn(turns[0], role);
  if (recoveryDigest(turns[0].items) !== attempt.original_items_digest)
    throw new Error("Original initialization evidence changed");
  const prompt = initializationRecoveryPrompt(role, attempt.attempt_id, attempt.original_turn_id);
  if (recoveryDigest(prompt) !== attempt.prompt_digest)
    throw new Error("Recovery prompt digest mismatch");
  if (completed) {
    if (
      turns[1].id === turns[0].id ||
      (attempt.recovery_turn_id && turns[1].id !== attempt.recovery_turn_id)
    )
      throw new Error("Recovery turn identity mismatch");
    verifyRecoveryTurn(turns[1], prompt);
  }
  if (verify(attempt.workspace_path, source, attempt.thread_id) !== attempt.initial_head)
    throw new Error("Recovery worktree HEAD changed");
}

export type RecoveryDependencies = {
  read: typeof readRecoverySnapshot;
  writer: typeof withRecoveryWriter;
  verify: typeof verifyWorktree;
  capability?: () => void;
};
export async function recoverInitialization(
  store: LedgerStore,
  request: Request,
  operationId: string,
  allowStart: boolean,
  dependencies: RecoveryDependencies = {
    read: readRecoverySnapshot,
    writer: withRecoveryWriter,
    verify: verifyWorktree,
    capability: requireRecoveryCapability,
  },
  commit?: (result: { revision: number; reconciliation: Record<string, unknown> }) => void,
) {
  const ledger = validateLedger(store.read());
  if (request.actor.role !== "main" || request.actor.thread_id !== ledger.control.owner_thread_id)
    throw new ContractError("ACTOR_MISMATCH", "Recovery requires the bound main thread");
  if (ledger.revision !== request.expected_revision)
    throw new ContractError("REVISION_CONFLICT", "Ledger version changed", 3);
  const operation = ledger.operations.find(
    (item) => item.id === operationId && item.kind === "dispatch",
  );
  if (
    !operation ||
    operation.status !== "unknown" ||
    !operation.request.native_request_id ||
    !operation.request.observed_thread_id ||
    (operation.request.creation_parameters as any)?.transport !== "codex-exec"
  )
    throw new ContractError(
      "RECOVERY_NOT_ALLOWED",
      "Recovery requires an unknown CLI creation with an observed thread",
      5,
    );
  const parameters = record(operation.request.creation_parameters)!;
  if (typeof parameters.cwd !== "string") throw new Error("Frozen source workspace unavailable");
  const source = parameters.cwd;
  const role: AgentRole =
    operation.request.target_type === "group" ? "Delivery Agent" : "Task Agent";
  const profile = executionProfile.parse(operation.request.execution_profile);
  let revision = request.expected_revision;
  let attempt: RecoveryAttempt;
  let start = false;
  if (operation.request.initialization_recovery) {
    attempt = recoveryAttempt.parse(operation.request.initialization_recovery);
  } else {
    if (!allowStart)
      throw new Error("Interrupted initialization requires explicit initialization-recover");
    dependencies.capability?.();
    const history = await dependencies.read(String(operation.request.observed_thread_id));
    const original = history.turns[0];
    if (!original || typeof original.id !== "string" || typeof history.thread.cwd !== "string")
      throw new Error("Original initialization unavailable");
    const attemptId = `recovery-${randomUUID()}`;
    attempt = recoveryAttempt.parse({
      attempt_id: attemptId,
      native_request_id: operation.request.native_request_id,
      thread_id: operation.request.observed_thread_id,
      original_turn_id: original.id,
      original_items_digest: recoveryDigest(original.items),
      prompt_version: 1,
      prompt_digest: recoveryDigest(initializationRecoveryPrompt(role, attemptId, original.id)),
      workspace_path: history.thread.cwd,
      initial_head: dependencies.verify(
        history.thread.cwd,
        source,
        String(operation.request.observed_thread_id),
      ),
      execution_profile: profile,
      permissions: { version: 1 },
    });
    verifyRecoveryHistory(history, attempt, source, role, false, () => attempt.initial_head);
    // This durable claim is never expired or reset. A crash before send requires audit, not resend.
    const claimed = record(
      store.update((raw) =>
        apply(raw, "initialization-recovery-claim", {
          ...request,
          request_id: `recovery-claim-${recoveryDigest(request.request_id)}`,
          payload: { operation_id: operationId, attempt },
        }),
      ),
    );
    revision = Number(claimed?.revision);
    start = true;
  }
  if (
    attempt.native_request_id !== operation.request.native_request_id ||
    attempt.thread_id !== operation.request.observed_thread_id ||
    recoveryDigest(attempt.execution_profile) !== recoveryDigest(profile)
  )
    throw new Error("Recovery attempt binding changed");
  return dependencies.writer(
    attempt,
    async (native, restore) => {
      if (start) {
        // The private server now owns the native writer lock: inspect again before sending anything.
        verifyRecoveryHistory(
          await readRecoveryHistory(native, attempt.thread_id),
          attempt,
          source,
          role,
          false,
          dependencies.verify,
        );
        const prompt = initializationRecoveryPrompt(
          role,
          attempt.attempt_id,
          attempt.original_turn_id,
        );
        const started = await native("turn/start", {
          threadId: attempt.thread_id,
          model: profile.model,
          effort: profile.thinking,
          input: [{ type: "text", text: prompt, text_elements: [] }],
        });
        const turnId = record(started.turn)?.id;
        if (typeof turnId !== "string")
          throw new Error("Native recovery turn identity unavailable");
        const observed = record(
          store.update((raw) =>
            apply(raw, "initialization-recovery-observe", {
              ...request,
              expected_revision: revision,
              request_id: `recovery-turn-${recoveryDigest(request.request_id)}`,
              payload: {
                operation_id: operationId,
                attempt_id: attempt.attempt_id,
                turn_id: turnId,
              },
            }),
          ),
        );
        revision = Number(observed?.revision);
        attempt = { ...attempt, recovery_turn_id: turnId };
        for (;;) {
          const history = await readRecoveryHistory(native, attempt.thread_id);
          if (history.turns[1]?.status === "completed") {
            verifyRecoveryHistory(history, attempt, source, role, true, dependencies.verify);
            break;
          }
          if (
            history.turns.length !== 2 ||
            history.turns[1]?.id !== turnId ||
            history.turns[1]?.status !== "inProgress"
          )
            throw new Error("Recovery handshake stopped without completion");
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      // Keep the native mutation fence through the synchronous ledger resolution, including reentry.
      const history = await readRecoveryHistory(native, attempt.thread_id);
      verifyRecoveryHistory(history, attempt, source, role, true, dependencies.verify);
      const turnId = String(history.turns[1].id);
      if (!attempt.recovery_turn_id) {
        const observed = record(
          store.update((raw) =>
            apply(raw, "initialization-recovery-observe", {
              ...request,
              expected_revision: revision,
              request_id: `recovery-turn-${recoveryDigest(request.request_id)}`,
              payload: {
                operation_id: operationId,
                attempt_id: attempt.attempt_id,
                turn_id: turnId,
              },
            }),
          ),
        );
        revision = Number(observed?.revision);
      }
      const result = {
        revision,
        reconciliation: {
          thread_id: attempt.thread_id,
          workspace_path: attempt.workspace_path,
          initial_head: attempt.initial_head,
          model: profile.model,
          thinking: profile.thinking,
          turn_completed: true,
          initialization_turn_id: attempt.original_turn_id,
          evidence_ref: `codex-initialization-recovery:${attempt.attempt_id}`,
          created_at: new Date().toISOString(),
          reconciliation_mode: "app-server",
          diagnostics: [],
          initialization_recovery: {
            attempt_id: attempt.attempt_id,
            original_turn_id: attempt.original_turn_id,
            recovery_turn_id: turnId,
            prompt_digest: attempt.prompt_digest,
            transport: "codex-app-server-private-unix",
            native_version: "0.169.0",
            restored_permissions_digest: recoveryDigest(attempt.permissions?.original),
          },
        },
      };
      // The READY turn is only evidence of a handshake. Formal dispatch requires restored permissions.
      await restore();
      commit?.(result);
      return result;
    },
    {
      restrict: start,
      capture: (original) => {
        const saved = record(
          store.update((raw) =>
            apply(raw, "initialization-recovery-permissions", {
              ...request,
              expected_revision: revision,
              request_id: `recovery-permissions-${recoveryDigest(request.request_id)}`,
              payload: { operation_id: operationId, attempt_id: attempt.attempt_id, original },
            }),
          ),
        );
        revision = Number(saved?.revision);
        attempt = { ...attempt, permissions: { version: 1, original } };
      },
    },
  );
}
