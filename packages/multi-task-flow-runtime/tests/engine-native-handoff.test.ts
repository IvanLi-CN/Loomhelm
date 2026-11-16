import { describe, expect, test } from "bun:test";
import { apply, type Request } from "../lib/engine";
import { type Ledger, type Task, validateLedger } from "../lib/schema";
import {
  approve,
  at,
  base,
  fixture,
  groupActor,
  head,
  main,
  merge,
  request,
  v2Fixture,
} from "./engine-fixtures";

describe("native CLI handoff contract", () => {
  function claimed() {
    const ledger = fixture();
    approve(ledger);
    apply(
      ledger,
      "dispatch-claim",
      request(ledger, "cli-claim", { task_id: "a", operation_id: "cli-a" }),
    );
    apply(
      ledger,
      "dispatch-bind-request",
      request(ledger, "cli-bind", {
        operation_id: "cli-a",
        native_request_id: "cli-request",
        creation_parameters: {
          title: "task",
          prompt: "formal",
          cwd: "/repo",
          transport: "codex-exec",
          execution_profile: ledger.config.execution_profile,
        },
      }),
    );
    return ledger;
  }
  function resolve(ledger: ReturnType<typeof fixture>, exit_code = 0) {
    return request(ledger, "cli-resolve", {
      operation_id: "cli-a",
      outcome: "succeeded",
      thread_id: "cli-thread",
      native_evidence: {
        source: "multi-task-flow-cli",
        native_tool_name: "codex exec",
        operation_id: "cli-a",
        native_request_id: "cli-request",
        ...ledger.config.execution_profile,
        created_at: at,
        evidence_ref: "codex-exec:cli-request",
        thread_id: "cli-thread",
        exit_code,
        turn_completed: true,
        workspace_path: "/owned/worktree",
        initial_head: head,
      },
    });
  }
  test("reconciliation evidence can resolve an observed unknown without changing native identity", () => {
    const ledger = claimed();
    apply(
      ledger,
      "dispatch-progress",
      request(ledger, "reconcile-observed", {
        operation_id: "cli-a",
        native_request_id: "cli-request",
        thread_id: "cli-thread",
      }),
    );
    const payload = resolve(ledger).payload as any;
    payload.native_evidence = {
      ...payload.native_evidence,
      source: "multi-task-flow-reconcile",
      evidence_ref: "codex-thread-reconcile:cli-thread",
    };
    delete payload.native_evidence.exit_code;
    apply(ledger, "dispatch-resolve", request(ledger, "reconcile-resolve", payload));
    expect(ledger.operations[0].status).toBe("succeeded");
    expect(ledger.operations[0].request.native_request_id).toBe("cli-request");
    expect(ledger.tasks[0].thread_id).toBe("cli-thread");
  });
  test("native success cannot omit the transport used by baseline and handoff gates", () => {
    for (const parameters of [undefined, { cwd: "/repo" }]) {
      const ledger = claimed();
      ledger.operations[0].request.creation_parameters = parameters;
      apply(
        ledger,
        "dispatch-progress",
        request(ledger, "observed", {
          operation_id: "cli-a",
          native_request_id: "cli-request",
          thread_id: "cli-thread",
        }),
      );
      const before = JSON.stringify(ledger);
      expect(() => apply(ledger, "dispatch-resolve", resolve(ledger))).toThrow(
        "bound native transport",
      );
      expect(JSON.stringify(ledger)).toBe(before);
      expect(ledger.tasks[0].thread_id).toBeNull();
    }
  });
  test("identity is durable before binding; failed exit cannot bind and replay cannot create again", () => {
    const ledger = claimed();
    expect(() => apply(ledger, "dispatch-resolve", resolve(ledger))).toThrow("observed identity");
    const progress = request(ledger, "cli-observed", {
      operation_id: "cli-a",
      native_request_id: "cli-request",
      thread_id: "cli-thread",
    });
    apply(ledger, "dispatch-progress", progress);
    expect(ledger.tasks[0].thread_id).toBeNull();
    expect(ledger.operations[0].request.observed_thread_id).toBe("cli-thread");
    expect((apply(ledger, "dispatch-progress", progress) as any).code).toBe("REPLAYED");
    expect(() => apply(ledger, "dispatch-resolve", resolve(ledger, 1))).toThrow("CLI exit");
    apply(ledger, "dispatch-resolve", resolve(ledger));
    expect(ledger.tasks[0].thread_id).toBe("cli-thread");
    expect(ledger.notifications[0].recipient_thread_id).toBe("cli-thread");
    expect(ledger.notifications[0].delivery_status).toBe("pending");
    expect(() =>
      apply(
        ledger,
        "dispatch-claim",
        request(ledger, "duplicate-create", { task_id: "a", operation_id: "second-a" }),
      ),
    ).toThrow();
  });
  test("observed CLI identity cannot release the claim through failed or legacy evidence", () => {
    const ledger = claimed();
    apply(
      ledger,
      "dispatch-progress",
      request(ledger, "observed-before-failure", {
        operation_id: "cli-a",
        native_request_id: "cli-request",
        thread_id: "cli-thread",
      }),
    );
    for (const native_tool_name of ["codex exec", "thread/start"]) {
      const failure = resolve(ledger);
      Object.assign(failure.payload, { outcome: "failed" });
      Object.assign(failure.payload.native_evidence, {
        native_tool_name,
        error: "Initialization failed",
        process_started: false,
        resources_created: false,
      });
      expect(() => apply(ledger, "dispatch-resolve", failure)).toThrow();
      expect(ledger.operations[0].status).toBe("unknown");
      expect(ledger.operations[0].request.observed_thread_id).toBe("cli-thread");
      expect(() =>
        apply(
          ledger,
          "dispatch-claim",
          request(ledger, `retry-${native_tool_name}`, {
            task_id: "a",
            operation_id: "duplicate-a",
          }),
        ),
      ).toThrow();
    }
    const unobserved = claimed();
    const failure = resolve(unobserved);
    Object.assign(failure.payload, { outcome: "failed" });
    Object.assign(failure.payload.native_evidence, {
      error: "No event received after process start",
    });
    expect(() => apply(unobserved, "dispatch-resolve", failure)).toThrow("require reconciliation");
    expect(unobserved.operations[0].status).toBe("unknown");
  });
  test("same native request freezes every creation parameter, including transport", () => {
    const ledger = claimed();
    const parameters = structuredClone(ledger.operations[0].request.creation_parameters) as any;
    for (const change of [
      { transport: undefined },
      { cwd: "/another-repo" },
      { prompt: "different task" },
      { title: "different title" },
      { execution_profile: { model: "gpt-6-luna", thinking: "low" } },
    ]) {
      const before = JSON.stringify(ledger);
      expect(() =>
        apply(
          ledger,
          "dispatch-bind-request",
          request(ledger, `rebind-${Object.keys(change)[0]}`, {
            operation_id: "cli-a",
            native_request_id: "cli-request",
            creation_parameters: { ...parameters, ...change },
          }),
        ),
      ).toThrow("frozen");
      expect(JSON.stringify(ledger)).toBe(before);
    }
    apply(
      ledger,
      "dispatch-bind-request",
      request(ledger, "identical-rebind", {
        operation_id: "cli-a",
        native_request_id: "cli-request",
        creation_parameters: parameters,
      }),
    );
    apply(
      ledger,
      "dispatch-bind-request",
      request(ledger, "identity-only-rebind", {
        operation_id: "cli-a",
        native_request_id: "cli-request",
      }),
    );
    expect(ledger.operations[0].request.creation_parameters).toEqual(parameters);
    expect(ledger.operations[0].status).toBe("unknown");
  });
  test("unknown reports retain creation facts across later empty reports and cannot release retry protection", () => {
    for (const report of [
      { thread_id: "cli-thread" },
      { native_evidence: { workspace_path: "/allocated" } },
      { native_evidence: { initial_head: head } },
      { native_evidence: { exit_code: 1 } },
      { native_evidence: { turn_completed: true } },
      { native_evidence: { events: ["turn.started"] } },
      { native_evidence: { process_started: true } },
      { native_evidence: { resources_created: true } },
    ]) {
      const ledger = claimed();
      apply(
        ledger,
        "dispatch-resolve",
        request(ledger, "known-unknown", { operation_id: "cli-a", outcome: "unknown", ...report }),
      );
      const observed = structuredClone(ledger.operations[0].request.creation_observations);
      expect(Object.keys(observed as object).length).toBeGreaterThan(0);
      apply(
        ledger,
        "dispatch-resolve",
        request(ledger, "empty-unknown", { operation_id: "cli-a", outcome: "unknown" }),
      );
      expect(ledger.operations[0].request.creation_observations).toEqual(observed);
      const failure = request(ledger, "false-preflight", {
        operation_id: "cli-a",
        outcome: "failed",
        native_evidence: {
          source: "multi-task-flow-cli",
          native_tool_name: "codex exec",
          operation_id: "cli-a",
          native_request_id: "cli-request",
          ...ledger.config.execution_profile,
          created_at: at,
          evidence_ref: "preflight:incorrect",
          error: "No resources",
          process_started: false,
          resources_created: false,
        },
      });
      expect(() => apply(ledger, "dispatch-resolve", failure)).toThrow("require reconciliation");
      expect(ledger.operations[0].status).toBe("unknown");
      expect(() =>
        apply(
          ledger,
          "dispatch-claim",
          request(ledger, "retry-known", { task_id: "a", operation_id: "duplicate-a" }),
        ),
      ).toThrow();
    }
  });
  test("historical unknown identity blocks failed resolution even without exec transport or progress event", () => {
    const ledger = claimed();
    delete (ledger.operations[0].request.creation_parameters as any).transport;
    ledger.operations[0].status = "claimed";
    ledger.operations[0].request.creation_result = {
      outcome: "unknown",
      thread_id: "prior-cli-thread",
    };
    const before = JSON.stringify(ledger);
    const failure = request(ledger, "historical-failure", {
      operation_id: "cli-a",
      outcome: "failed",
      native_evidence: {
        source: "multi-task-flow-cli",
        native_tool_name: "thread/start",
        operation_id: "cli-a",
        native_request_id: "cli-request",
        ...ledger.config.execution_profile,
        created_at: at,
        evidence_ref: "legacy:failure",
        error: "Failed",
      },
    });
    expect(() => apply(ledger, "dispatch-resolve", failure)).toThrow("require reconciliation");
    expect(JSON.stringify(ledger)).toBe(before);
    apply(
      ledger,
      "dispatch-resolve",
      request(ledger, "retain-history", { operation_id: "cli-a", outcome: "unknown" }),
    );
    expect(ledger.operations[0].request.observed_thread_id).toBe("prior-cli-thread");
    expect(() =>
      apply(
        ledger,
        "dispatch-resolve",
        request(ledger, "replace-known-id", {
          operation_id: "cli-a",
          outcome: "unknown",
          thread_id: "contradictory-thread",
        }),
      ),
    ).toThrow("cannot change");
  });
  test("codex exec failure requires explicit pre-creation evidence even without stored transport", () => {
    const ledger = claimed();
    delete (ledger.operations[0].request.creation_parameters as any).transport;
    ledger.operations[0].status = "claimed";
    expect(() =>
      apply(
        ledger,
        "dispatch-resolve",
        request(ledger, "unsafe-exec-failure", {
          operation_id: "cli-a",
          outcome: "failed",
          native_evidence: {
            source: "multi-task-flow-cli",
            native_tool_name: "codex exec",
            operation_id: "cli-a",
            native_request_id: "cli-request",
            ...ledger.config.execution_profile,
            created_at: at,
            evidence_ref: "codex:ambiguous",
            error: "failed",
          },
        }),
      ),
    ).toThrow("pre-creation failure");
    expect(ledger.operations[0].status).toBe("claimed");
  });
  test("development waits for owned workspace readiness and the current parent SHA, separate from initial HEAD", () => {
    const ledger = claimed();
    apply(
      ledger,
      "dispatch-progress",
      request(ledger, "cli-observed", {
        operation_id: "cli-a",
        native_request_id: "cli-request",
        thread_id: "cli-thread",
      }),
    );
    apply(ledger, "dispatch-resolve", resolve(ledger));
    expect(ledger.notifications.at(-1)?.event_id).toBe("cli-resolve-creation");
    const actor = { role: "task" as const, thread_id: "cli-thread" };
    expect(() =>
      apply(
        ledger,
        "task-update",
        request(
          ledger,
          "too-early",
          { task_id: "a", state: "running", detail: "Start after readiness", occurred_at: at },
          actor,
        ),
      ),
    ).toThrow("baseline");
    apply(
      ledger,
      "task-runtime-observe",
      request(ledger, "initial-idle", {
        task_id: "a",
        thread_id: "cli-thread",
        runtime: "idle",
        turn_id: "completed-initialization",
        observed_at: new Date().toISOString(),
      }),
    );
    expect(ledger.tasks[0].state).toBe("agent_idle");
    expect(() =>
      apply(
        ledger,
        "task-update",
        request(
          ledger,
          "idle-too-early",
          { task_id: "a", state: "running", detail: "Resume after readiness", occurred_at: at },
          actor,
        ),
      ),
    ).toThrow("baseline");
    ledger.config.max_running_tasks = 1;
    ledger.resources = [
      {
        id: "wt",
        kind: "worktree",
        target: "a",
        status: "active",
        evidence_ref: "owned:cli-thread",
      },
      {
        id: "br",
        kind: "branch",
        target: "task-a",
        status: "active",
        evidence_ref: "owned:branch",
      },
    ];
    const payload = {
      target_type: "task",
      target_id: "a",
      stage: "workspace_ready",
      branch: "task-a",
      resource_ids: ["wt", "br"],
      evidence_ref: "git:clean",
    };
    expect(() =>
      apply(ledger, "lifecycle-record", request(ledger, "missing-baseline", payload, actor)),
    ).toThrow();
    expect(() =>
      apply(
        ledger,
        "lifecycle-record",
        request(
          ledger,
          "wrong-baseline",
          { ...payload, baseline: { sha: head, head, clean: true, source: "group:g" } },
          actor,
        ),
      ),
    ).toThrow("parent SHA");
    expect(() =>
      apply(
        ledger,
        "lifecycle-record",
        request(
          ledger,
          "dirty-baseline",
          { ...payload, baseline: { sha: base, head: base, clean: false, source: "group:g" } },
          actor,
        ),
      ),
    ).toThrow();
    apply(
      ledger,
      "lifecycle-record",
      request(
        ledger,
        "ready-baseline",
        { ...payload, baseline: { sha: base, head: base, clean: true, source: "group:g" } },
        actor,
      ),
    );
    apply(
      ledger,
      "task-update",
      request(
        ledger,
        "start",
        { task_id: "a", state: "running", detail: "Start after readiness", occurred_at: at },
        actor,
      ),
    );
    expect(ledger.tasks[0].base_sha).toBe(base);
    expect((ledger.operations[0].request.creation_result as any).native_evidence.initial_head).toBe(
      head,
    );
  });
});
