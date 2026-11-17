// Disposable integration acceptance. Native policy persistence is modeled; Desktop is not controlled.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendCodexMessage } from "../../lib/codex-agent-api.ts";
import { initializationPrompt } from "../../lib/codex-cli-initialization.ts";
import { withRecoveryWriter } from "../../lib/codex-recovery-writer.ts";
import { versionEnvelope } from "../../lib/contract.ts";
import { apply } from "../../lib/engine.ts";
import { recoverInitialization } from "../../lib/initialization-recovery.ts";
import { recoveryDigest } from "../../lib/initialization-recovery-attempt.ts";
import { prepareNativeNotification } from "../../lib/notification-delivery.ts";
import { LedgerStore } from "../../lib/store";
import { fixtureIdentity } from "../cli-identity-fixture.ts";
import { approveV2, head, request, v2Fixture } from "../engine-fixtures.ts";
import { serveFixture } from "./recovery-native.ts";

const directory = realpathSync(mkdtempSync(join(tmpdir(), "mfr-policy-repro-")));
const statePath = join(directory, "state.json");
const original = { sandbox_policy: { type: "danger-full-access" }, approval_policy: "never" };
const saved = Object.fromEntries(
  [
    "PATH",
    "PROBE_STATE",
    "LOOMHELM_CODEX_APP_SERVER_SOCKET",
    "MULTI_TASK_FLOW_CODEX_CREATE_TIMEOUT_MS",
  ].map((k) => [k, process.env[k]]),
);
let server: ReturnType<typeof serveFixture> | undefined;
try {
  let ledger = v2Fixture();
  ledger.contract_version = 4;
  ledger.runtime_identity = fixtureIdentity;
  ledger.version = versionEnvelope;
  ledger.tasks[0].kind = "verification";
  for (const task of ledger.tasks.slice(1)) {
    task.execution_owner = "task_agent";
    task.conversation_policy = "task_agent";
    task.delivery_policy = "child_pr";
  }
  ledger.groups[0].state = "merged";
  ledger.groups[0].merge_sha = head;
  approveV2(ledger);
  apply(ledger, "dispatch-claim", request(ledger, "claim", { task_id: "a", operation_id: "op" }));
  apply(
    ledger,
    "dispatch-bind-request",
    request(ledger, "bind", {
      operation_id: "op",
      native_request_id: "native",
      creation_parameters: {
        title: "fixture",
        prompt: "formal task fixture",
        cwd: directory,
        transport: "codex-exec",
        execution_profile: ledger.config.execution_profile,
      },
    }),
  );
  apply(
    ledger,
    "dispatch-progress",
    request(ledger, "observed", {
      operation_id: "op",
      native_request_id: "native",
      thread_id: "fixture-thread",
    }),
  );
  writeFileSync(
    statePath,
    JSON.stringify({
      policy: { type: "dangerFullAccess" },
      approval: original.approval_policy,
      thread: {
        id: "fixture-thread",
        cwd: directory,
        status: { type: "idle" },
        model: ledger.config.execution_profile!.model,
        reasoningEffort: ledger.config.execution_profile!.thinking,
      },
      turns: [
        {
          id: "original-turn",
          status: "interrupted",
          itemsView: "full",
          items: [
            {
              type: "userMessage",
              content: [{ type: "text", text: initializationPrompt("Task Agent") }],
            },
          ],
        },
      ],
      calls: [],
      contexts: [],
    }),
  );
  const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
  const executable = join(directory, "codex");
  writeFileSync(
    executable,
    `#!${process.execPath}\nimport { serveFixture } from ${JSON.stringify(join(import.meta.dir, "recovery-native.ts"))};\nif (process.argv.includes('--version')) { console.log('codex-cli 0.169.0'); process.exit(0); }\nconst endpoint = process.argv.at(-1);\nif (!endpoint.startsWith('unix://')) throw new Error('private endpoint required');\nserveFixture(endpoint.slice(7), process.env.PROBE_STATE);\n`,
  );
  chmodSync(executable, 0o700);
  process.env.PATH = `${directory}:${saved.PATH}`;
  process.env.PROBE_STATE = statePath;
  process.env.MULTI_TASK_FLOW_CODEX_CREATE_TIMEOUT_MS = "5000";
  const store = new LedgerStore(directory, "run");
  store.create(ledger);
  process.env.PROBE_LEDGER = store.ledgerPath;
  await recoverInitialization(
    store,
    request(ledger, "recover", {}),
    "op",
    true,
    {
      read: async () => ({ thread: readState().thread, turns: readState().turns }),
      writer: (attempt, action, options) =>
        withRecoveryWriter(
          attempt,
          (native, restore) =>
            action(native, async () => {
              // A snapshot digest can be forged from readable ledger state. Even valid
              // evidence must not bypass the native writer's verified restoration.
              const before = readFileSync(store.ledgerPath, "utf8");
              const current = store.read() as typeof ledger;
              const registered = current.operations[0].request.initialization_recovery!;
              assert.equal(readState().policy.type, "readOnly");
              const bypass = spawnSync(
                process.execPath,
                [
                  join(import.meta.dir, "../../scripts/orchestrate.ts"),
                  "dispatch-resolve",
                  "--input",
                  "-",
                ],
                {
                  env: { ...process.env, TASK_ORCHESTRATION_DATA_ROOT: directory },
                  input: JSON.stringify({
                    ...request(current, "bypass-before-restore", {}),
                    payload: {
                      operation_id: "op",
                      outcome: "succeeded",
                      thread_id: "fixture-thread",
                      native_evidence: {
                        source: "multi-task-flow-reconcile",
                        native_tool_name: "codex exec",
                        operation_id: "op",
                        native_request_id: "native",
                        thread_id: registered.thread_id,
                        workspace_path: registered.workspace_path,
                        initial_head: registered.initial_head,
                        model: registered.execution_profile.model,
                        thinking: registered.execution_profile.thinking,
                        turn_completed: true,
                        initialization_turn_id: registered.original_turn_id,
                        evidence_ref: `codex-initialization-recovery:${registered.attempt_id}`,
                        created_at: new Date().toISOString(),
                        reconciliation_mode: "app-server",
                        diagnostics: [],
                        initialization_recovery: {
                          attempt_id: registered.attempt_id,
                          original_turn_id: registered.original_turn_id,
                          recovery_turn_id: registered.recovery_turn_id,
                          prompt_digest: registered.prompt_digest,
                          transport: "codex-app-server-private-unix",
                          native_version: "0.169.0",
                          restored_permissions_digest: recoveryDigest(
                            registered.permissions!.original,
                          ),
                        },
                      },
                    },
                  }),
                  encoding: "utf8",
                },
              );
              assert.equal(bypass.status, 5, bypass.stdout + bypass.stderr);
              assert.equal(JSON.parse(bypass.stdout).code, "CLI_ONLY_DISPATCH");
              assert.equal(readFileSync(store.ledgerPath, "utf8"), before);
              assert.equal(readState().policy.type, "readOnly");
              await restore();
            }),
          options,
        ),
      verify: () => head,
    },
    (recovered) => {
      store.update((raw) =>
        apply(raw, "dispatch-resolve", {
          ...request(ledger, "resolve", {}),
          expected_revision: recovered.revision,
          payload: {
            operation_id: "op",
            outcome: "succeeded",
            thread_id: "fixture-thread",
            native_evidence: {
              source: "multi-task-flow-reconcile",
              native_tool_name: "codex exec",
              operation_id: "op",
              native_request_id: "native",
              ...recovered.reconciliation,
            },
          },
        }),
      );
    },
  );
  ledger = store.read() as typeof ledger;
  assert.equal(ledger.operations[0].status, "succeeded");
  assert.equal(readState().contexts[0].sandbox_policy.type, "read-only");

  const notificationId = String(ledger.operations[0].request.handoff_notification_id);
  const handoff = prepareNativeNotification(
    store,
    request(ledger, "prepare-handoff", {}),
    notificationId,
    "formal task fixture",
  );
  assert.equal(handoff.should_send, true);
  assert.equal(handoff.next_action, "send_message_to_thread");
  assert.deepEqual(Object.keys(handoff.tool_request).sort(), ["prompt", "threadId"]);
  server = serveFixture(join(directory, "shared"), statePath);
  process.env.LOOMHELM_CODEX_APP_SERVER_SOCKET = join(directory, "shared");
  // The real Desktop tool is outside this harness. Exercise the repository's
  // sender adapter with the exact handoff recipient and prompt as a surrogate.
  const delivered = await sendCodexMessage({
    recipient_thread_id: handoff?.tool_request.threadId ?? "fixture-thread",
    prompt: handoff?.tool_request.prompt ?? "formal task fixture",
    request_id: "formal-request",
  });
  assert.equal(delivered.outcome, "sent");
  await new Promise((resolve) => setTimeout(resolve, 60));
  await sendCodexMessage({
    recipient_thread_id: "fixture-thread",
    prompt: "second formal turn",
    request_id: "formal-request-2",
  });
  const cli = spawnSync(
    process.execPath,
    [join(import.meta.dir, "../../scripts/orchestrate.ts"), "show", "--input", "-"],
    {
      env: { ...process.env, TASK_ORCHESTRATION_DATA_ROOT: directory },
      input: JSON.stringify({
        run_id: "run",
        section: "task-context",
        task_id: "a",
        actor: { role: "task", thread_id: "fixture-thread" },
      }),
      encoding: "utf8",
    },
  );
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(JSON.parse(cli.stdout).result.task.id, "a");
  const state = readState();
  assert.equal(state.contexts.length, 3);
  for (const formal of state.contexts.slice(1)) {
    assert.deepEqual(formal.sandbox_policy, original.sandbox_policy);
    assert.equal(formal.approval_policy, original.approval_policy);
  }
  const formal = state.contexts.at(-1);
  const evidence = {
    mode: "full recovery and two formal dispatches",
    fixture_limit: "native persistence is modeled; no model call or OS sandbox is executed",
    recovery: ledger.operations[0].status,
    delivery: delivered.outcome,
    desktop_handoff: handoff
      ? { next_action: handoff.next_action, tool_request_keys: Object.keys(handoff.tool_request) }
      : null,
    original,
    formal,
    calls: state.calls.map((c: any) => ({
      method: c.method,
      ...(c.method === "thread/resume"
        ? {
            sandbox: c.params.sandbox ?? "omitted",
            approvalPolicy: c.params.approvalPolicy ?? "omitted",
          }
        : {}),
    })),
  };
  console.log(JSON.stringify(evidence, null, 2));
  assert.deepEqual(
    formal.sandbox_policy,
    original.sandbox_policy,
    "Formal dispatch must preserve pre-recovery permissions",
  );
  assert.equal(formal.approval_policy, original.approval_policy);
  console.log("PASS: formal dispatch retained the original authorized configuration");
} finally {
  server?.stop(true);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
}
