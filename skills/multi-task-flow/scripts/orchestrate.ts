import { desktopHandoff } from "./desktop-handoff";
import { createCliThread } from "./codex-cli-create";
import { Runtime } from "../../bin/modules/core/runtime";
import {
  effectiveProfile,
  materializeRecommendation,
  validateProfileCapability,
} from "./execution-profile";
import { mutateExecutionProfile } from "./profile-mutation";
import { z, ZodError } from "zod";
import { randomUUID } from "node:crypto";
import { ContractError } from "./errors";
import { apply, actorSchema, requestSchema } from "./engine";
import { readCodexCapabilities } from "./codex-agent-api";
import {
  group,
  id,
  ledgerSchema,
  plan,
  task,
  type Ledger,
  validateInitialRuntimeState,
  validateLedger,
  validatePlan,
  defaultGroupAtoms,
  executionProfile,
  DEFAULT_EXECUTION_PROFILE,
} from "./schema";
import { defaultRoot, LedgerStore } from "./store";
import { prepareNativeNotification, reconcileNotification } from "./notification-delivery";
import { migrationCanonicalInput } from "./store-migration";
import { buildView } from "./view";
import { checkViewerCompatibility, renewViewerUsage } from "./service-usage";

const initialRequest = z
  .object({
    run_id: id,
    actor: actorSchema,
    payload: z
      .object({
        repository: ledgerSchema.shape.repository,
        config: ledgerSchema.shape.config,
        initial_plan: plan,
        groups: z.array(group),
        tasks: z.array(task),
      })
      .strict(),
  })
  .strict();
const migrationRequest = z
  .object({
    run_id: id,
    actor: actorSchema,
    request_id: id,
    expected_revision: z.number().int().nonnegative(),
    payload: z.object({}).strict(),
  })
  .strict();

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function notificationRequestOf(value: unknown): JsonRecord | null {
  const result = record(record(value)?.result);
  const request = record(result?.notification_request);
  if (
    typeof request?.notification_id !== "string" ||
    typeof request?.event_id !== "string" ||
    typeof request?.recipient_thread_id !== "string"
  )
    return null;
  return request;
}

function notificationPrompt(
  runId: string,
  notificationId: string,
  eventId: string,
  ledger: Ledger,
  input: JsonRecord,
): string {
  const event = ledger.events.find((item) => item.id === eventId);
  const payload = record(input.payload);
  const dispatch = ledger.operations.find(op => op.request.handoff_notification_id === notificationId);
  if (dispatch) {
    const handoff = desktopHandoff(ledger, dispatch.id, String(record(dispatch.request.creation_parameters)?.prompt));
    if (handoff) return `${handoff.formal_prompt}\n\nnotification_id: ${notificationId}\n处理后由当前收件会话 notification-ack 确认；发送接受不等于开工。`;
  }
  const lines = [
    "multi-task-flow notification",
    `run_id: ${runId}`,
    `notification_id: ${notificationId}`,
    `event_id: ${eventId}`,
    `event_type: ${event?.type ?? "unknown"}`,
    `subject_id: ${event?.subject_id ?? "unknown"}`,
  ];
  for (const key of [
    "task_id",
    "group_id",
    "state",
    "detail",
    "outcome",
    "operation_id",
    "evidence",
  ]) {
    const value = payload?.[key];
    if (typeof value === "string" && value.length > 0)
      lines.push(`${key}: ${value}`);
  }
  const reason = record(event?.data)?.reason;
  if (typeof reason === "string" && reason.length > 0)
    lines.push(`reason: ${reason}`);
  lines.push(
    "请处理这条通知；完成处理后，只能由当前收件会话调用 notification-ack 写入确认。",
  );
  return lines.join("\n");
}

async function deliverNotification(
  store: LedgerStore,
  parsed: z.infer<typeof requestSchema>,
  input: JsonRecord,
  request: JsonRecord,
  direct = false,
): Promise<unknown> {
  const ledger = validateLedger(store.read());
  const notificationId = String(request.notification_id);
  const notice = ledger.notifications.find(
    (item) => item.id === notificationId,
  );
  if (!notice) throw new ContractError("NOT_FOUND", "Notification not found");
  const prompt = notificationPrompt(
    parsed.run_id,
    notice.id,
    notice.event_id,
    ledger,
    input,
  );
  return prepareNativeNotification(store, parsed, notice.id, prompt, direct);
}

try {
  const command = process.argv[2];
  if (!command || process.argv[3] !== "--input" || process.argv[4] !== "-")
    throw new ContractError(
      "INVALID_ARGUMENTS",
      "Usage: orchestrate.ts <command> --input -",
    );
  const input = JSON.parse(await Runtime.stdin.text());
  const root = process.env.TASK_ORCHESTRATION_DATA_ROOT ?? defaultRoot();
  checkViewerCompatibility(root);
  if (command === "init") {
    const parsed = initialRequest.parse(input);
    if (parsed.actor.role !== "main")
      throw new ContractError(
        "FORBIDDEN",
        "Only the main conversation may initialize a run",
        3,
      );
    const requestedPlan = parsed.payload.initial_plan;
    if (requestedPlan.approval_id !== null)
      throw new ContractError(
        "INVALID_PLAN",
        "Initial plan must be unapproved",
      );
    const configuredGroupIds = new Set(
      requestedPlan.group_atoms.map((atom) => atom.group_id),
    );
    const planGroupIds = new Set(
      requestedPlan.nodes
        .map((node) => node.group_id)
        .filter((groupId): groupId is string => groupId !== null),
    );
    if (!parsed.payload.groups.every((item) => planGroupIds.has(item.id)))
      throw new ContractError(
        "ORPHAN_GROUP",
        "Runtime group is not present in the active plan",
      );
    const initialPlan =
      configuredGroupIds.size === parsed.payload.groups.length
        ? requestedPlan
        : {
            ...requestedPlan,
            group_atoms: [
              ...requestedPlan.group_atoms,
              ...parsed.payload.groups
                .filter((item) => !configuredGroupIds.has(item.id))
                .flatMap((item) =>
                  defaultGroupAtoms(item.id).map(
                    ({ status: _status, ...atom }) => ({
                      ...atom,
                      group_id: item.id,
                    }),
                  ),
                ),
            ],
          };
    validatePlan(initialPlan);
    const groups = parsed.payload.groups.map((group) => {
      const plannedAtoms = initialPlan.group_atoms
        .filter((atom) => atom.group_id === group.id)
        .map((atom) => ({
          id: atom.id,
          title: atom.title,
          purpose: atom.purpose,
          output: atom.output,
          lifecycle_stage: atom.lifecycle_stage,
          status: "planned" as const,
        }));
      return group.atoms.length === 0 && plannedAtoms.length > 0
        ? { ...group, atoms: plannedAtoms }
        : group;
    });
    validateInitialRuntimeState(groups, parsed.payload.tasks);
    const timestamp = new Date().toISOString();
    const ledger = validateLedger({
      schema_version: 2,
      source_schema_version: null,
      contract_version: 2,
      orchestration_id: parsed.run_id,
      revision: 0,
      repository: parsed.payload.repository,
      control: {
        owner_thread_id: parsed.actor.thread_id,
        ownership: "bound",
        approval_id: null,
      },
      config: {
        ...parsed.payload.config,
        execution_profile:
          parsed.payload.config.execution_profile ?? DEFAULT_EXECUTION_PROFILE,
      },
      plans: [initialPlan],
      active_plan_id: initialPlan.id,
      execution_plan_id: initialPlan.id,
      groups,
      tasks: parsed.payload.tasks,
      follow_prs: [],
      facts: [],
      operations: [],
      events: [],
      milestones: [],
      requests: [],
      notifications: [],
      resources: [],
      updated_at: timestamp,
    });
    for (const target of [...ledger.groups, ...ledger.tasks])
      if (!target.execution_profile_source)
        materializeRecommendation(ledger, target);
    new LedgerStore(root, parsed.run_id).create(ledger);
    console.log(
      JSON.stringify({
        ok: true,
        code: "CREATED",
        revision: 0,
        result: { run_id: parsed.run_id },
      }),
    );
  } else if (
    [
      "execution-profile-migrate",
      "execution-profile-update",
      "execution-profile-default-update",
      "execution-profile-recommend",
    ].includes(command)
  ) {
    const parsed = requestSchema.parse(input);
    console.log(
      JSON.stringify(
        await mutateExecutionProfile(
          new LedgerStore(root, parsed.run_id),
          command,
          parsed,
        ),
      ),
    );
  } else if (command === "migrate") {
    const parsed = migrationRequest.parse(input);
    const result = new LedgerStore(root, parsed.run_id).migrate({
      ...parsed,
      canonical_input: migrationCanonicalInput(parsed.run_id, parsed.actor),
    });
    console.log(JSON.stringify(result));
  } else if (
    command === "notification-reconcile" &&
    input.request_id === undefined
  ) {
    const parsed = z
      .object({
        run_id: id,
        actor: actorSchema,
        status: z
          .enum(["pending", "sent", "failed", "unknown", "acknowledged"])
          .optional(),
      })
      .strict()
      .parse(input);
    const ledger = validateLedger(new LedgerStore(root, parsed.run_id).read());
    const allowed =
      ledger.control.ownership === "bound" &&
      (parsed.actor.role === "main"
        ? parsed.actor.thread_id === ledger.control.owner_thread_id
        : parsed.actor.role === "group"
          ? ledger.groups.some(
              (g) => g.agent_thread_id === parsed.actor.thread_id,
            )
          : ledger.tasks.some((t) => t.thread_id === parsed.actor.thread_id));
    if (!allowed)
      throw new ContractError(
        "ACTOR_MISMATCH",
        "Conversation is not bound to the run",
        3,
      );
    const notifications = parsed.status
      ? ledger.notifications.filter((item) => item.status === parsed.status)
      : ledger.notifications;
    console.log(
      JSON.stringify({
        ok: true,
        code: "OK",
        revision: ledger.revision,
        result: {
          notifications,
          pending: ledger.notifications.filter((item) =>
            ["pending", "failed", "unknown"].includes(item.status),
          ).length,
          unacknowledged: ledger.notifications.filter(
            (item) => item.status === "sent",
          ).length,
        },
      }),
    );
  } else if ((command === "notification-send" || command === "notification-prepare")) {
    const parsed = requestSchema.parse(input);
    const payload = z
      .object({ notification_id: id })
      .strict()
      .parse(parsed.payload);
    const store = new LedgerStore(root, parsed.run_id);
    const delivery = record(await deliverNotification(store, parsed, input, payload, true));
    console.log(JSON.stringify({
      ok: true, code: delivery?.replayed ? "REPLAYED" : "APPLIED",
      revision: delivery?.revision, result: delivery,
    }));
  } else if (command === "conversation-create") {
    const parsed = requestSchema.parse(input);
    const payload = z
      .object({
        operation_id: id,
        title: z.string().min(1),
        prompt: z.string().min(1),
      })
      .strict()
      .parse(parsed.payload);
    const store = new LedgerStore(root, parsed.run_id);
    let ledger = validateLedger(store.read());
    const operation = ledger.operations.find(
      (item) => item.id === payload.operation_id && item.kind === "dispatch",
    );
    if (!operation)
      throw new ContractError("NOT_FOUND", "Dispatch operation not found");
    const target =
      operation.request.target_type === "group"
        ? ledger.groups.find((item) => item.id === operation.target_id)
        : ledger.tasks.find((item) => item.id === operation.target_id);
    if (!target)
      throw new ContractError("NOT_FOUND", "Dispatch target not found");
    const profile = executionProfile.parse(operation.request.execution_profile);
    const creationParameters = {
      title: payload.title,
      prompt: payload.prompt,
      cwd: process.cwd(),
      execution_profile: profile,
      transport: "codex-exec",
    };
    if (
      ledger.requests.some(
        (item) => item.request_id === `${parsed.request_id}-bind`,
      )
    ) {
      store.update((raw) =>
        apply(raw, "dispatch-bind-request", {
          ...parsed,
          request_id: `${parsed.request_id}-bind`,
          payload: {
            operation_id: payload.operation_id,
            native_request_id: operation.request.native_request_id,
            creation_parameters: creationParameters,
          },
        }),
      );
      console.log(
        JSON.stringify({
          ok: true,
          code: "REPLAYED",
          revision: ledger.revision,
          handoff: { ...desktopHandoff(ledger, operation.id, payload.prompt), should_send: false,
            notification_id: operation.request.handoff_notification_id ?? null,
            next_action: "Inspect notification; pending requires notification-prepare, unknown requires reconciliation; never resend a replay" },
          result: operation.request.creation_result ?? {
            operation_id: operation.id,
            outcome: "unknown",
            native_request_id: operation.request.native_request_id,
          },
        }),
      );
      process.exit(0);
    }
    validateProfileCapability(profile, await readCodexCapabilities());
    if (
      JSON.stringify(profile) !==
      JSON.stringify(effectiveProfile(ledger, target))
    )
      throw new ContractError("PROFILE_CONFLICT", "Claim profile changed");
    if (operation.status !== "claimed" || operation.request.native_request_id)
      throw new ContractError(
        "CREATION_PENDING",
        "Creation already attempted; reconcile before retry",
      );
    const nativeRequestId = `multi-task-flow-${randomUUID()}`;
    store.update((raw) =>
      apply(raw, "dispatch-bind-request", {
        ...parsed,
        request_id: `${parsed.request_id}-bind`,
        expected_revision: parsed.expected_revision,
        payload: {
          operation_id: payload.operation_id,
          native_request_id: nativeRequestId,
          creation_parameters: creationParameters,
        },
      }),
    );
    const creation = await createCliThread({
      title: payload.title,
      prompt: payload.prompt,
      native_request_id: nativeRequestId,
      onThreadStarted: (threadId) => {
        const current = validateLedger(store.read());
        store.update(raw => apply(raw, "dispatch-progress", {
          ...parsed, request_id: `${parsed.request_id}-thread`, expected_revision: current.revision,
          payload: { operation_id: payload.operation_id, native_request_id: nativeRequestId, thread_id: threadId },
        }));
      },
      ...profile,
    });
    ledger = validateLedger(store.read());
    const result = store.update((raw) =>
      apply(raw, "dispatch-resolve", {
        ...parsed,
        request_id: `${parsed.request_id}-resolve`,
        expected_revision: ledger.revision,
        payload: {
          operation_id: payload.operation_id,
          outcome: creation.outcome,
          ...(creation.thread_id ? { thread_id: creation.thread_id } : {}),
          native_evidence: {
            source: "multi-task-flow-cli",
            native_tool_name: "codex exec",
            ...creation,
            created_at: new Date().toISOString(),
            native_request_id: nativeRequestId,
            operation_id: payload.operation_id,
            model: creation.model,
            thinking: creation.thinking,
            evidence_ref: creation.evidence_ref,
            ...(creation.error ? { error: creation.error } : {}),
          },
        },
      }),
    );
    const notification = notificationRequestOf(result);
    const delivery = notification ? record(await deliverNotification(store, parsed, input, notification)) : null;
    console.log(JSON.stringify({ ...record(result), revision: validateLedger(store.read()).revision, handoff: creation.outcome === "succeeded" ? {
      ...desktopHandoff(validateLedger(store.read()), operation.id, payload.prompt), ...delivery,
    } : null }));
  } else if (command === "show" || command === "view") {
    const parsed = z
      .object({
        run_id: id,
        actor: actorSchema,
        plan_id: id.optional(),
        section: z
          .enum([
            "summary",
            "plan",
            "tasks",
            "operations",
            "notifications",
            "full",
          ])
          .optional(),
      })
      .strict()
      .parse(input);
    const ledger = validateLedger(new LedgerStore(root, parsed.run_id).read());
    const allowed =
      ledger.control.ownership === "bound" &&
      (parsed.actor.role === "main"
        ? parsed.actor.thread_id === ledger.control.owner_thread_id
        : parsed.actor.role === "group"
          ? ledger.groups.some(
              (g) => g.agent_thread_id === parsed.actor.thread_id,
            )
          : ledger.tasks.some((t) => t.thread_id === parsed.actor.thread_id));
    if (!allowed)
      throw new ContractError(
        "ACTOR_MISMATCH",
        "Conversation is not bound to the run",
        3,
      );
    const section = parsed.section ?? "full";
    const sections = {
      summary: {
        orchestration_id: ledger.orchestration_id,
        revision: ledger.revision,
        control: ledger.control,
      },
      plan: ledger.plans,
      tasks: ledger.tasks,
      operations: ledger.operations,
      notifications: ledger.notifications,
      full: ledger,
    };
    console.log(
      JSON.stringify({
        ok: true,
        code: "OK",
        revision: ledger.revision,
        result:
          command === "view"
            ? buildView(ledger, parsed.plan_id)
            : sections[section],
      }),
    );
  } else {
    const parsed = requestSchema.parse(input);
    const store = new LedgerStore(root, parsed.run_id);
    const result = record(command === "notification-reconcile"
      ? reconcileNotification(store, parsed)
      : store.update((raw) => apply(raw, command, parsed)));
    if (!result)
      throw new ContractError("INVALID_RESULT", "Invalid command result");
    const request = notificationRequestOf(result);
    const delivered =
      request && result.code === "APPLIED"
        ? await deliverNotification(store, parsed, input, request)
        : null;
    if (delivered === null) console.log(JSON.stringify(result));
    else {
      console.log(
        JSON.stringify({
          ...result,
          result: {
            ...record(result.result),
            notification_delivery: delivered,
          },
        }),
      );
    }
  }
  try {
    renewViewerUsage(root, input.run_id);
  } catch {
    console.error(
      JSON.stringify({
        warning: "VIEWER_RENEWAL_FAILED",
        message:
          "Ledger operation completed but viewer lease renewal failed; use service ensure",
      }),
    );
  }
} catch (error) {
  let code = "IO_ERROR",
    exitCode = 6,
    message = "Local operation failed";
  if (error instanceof ContractError) {
    code = error.code;
    exitCode = error.exitCode;
    message = error.message;
  } else if (error instanceof ZodError || error instanceof SyntaxError) {
    code = "INVALID_INPUT";
    exitCode = 2;
    message = error.message;
  }
  console.log(
    JSON.stringify({ ok: false, code, revision: null, message, details: {} }),
  );
  process.exitCode = exitCode;
}
