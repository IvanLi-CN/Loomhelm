import { createDemoLedger } from "./ledger";
import { validateLedger } from "../../lib/schema";

export const viewerValidationId = "orchestration-viewer";
export const viewerValidationName = "编排展示与交互验收";

/** Named synthetic orchestration for source-viewer development acceptance. */
export function createViewerValidationLedger(referenceTime = Date.now()) {
  const names: Record<string, string> = {
    "orchestration-sample": viewerValidationId,
    "plan-1": "viewer-validation-plan",
    sample: "orchestration-lab",
    "multi-task-flow": "orchestration-viewer",
    "sample/multi-task-flow": "orchestration-lab/orchestration-viewer",
  };
  const run = JSON.parse(
    JSON.stringify(createDemoLedger(referenceTime), (_key, value) =>
      typeof value === "string" ? (names[value] ?? value) : value,
    ),
  );
  run.schema_version = 2;
  run.contract_version = 2;
  run.source_schema_version = null;
  const plan = run.plans[0];
  const at = run.updated_at;
  const contributionTasks = run.tasks.filter((task: { kind: string }) => task.kind === "contribution");
  plan.actions = run.groups.flatMap((group: { id: string }) => [
    { id: `${group.id}-publish-branch`, kind: "publish_branch", task_id: null, group_id: group.id, target_identity: `branch:${group.id}` },
    { id: `${group.id}-publish-pr`, kind: "publish_pr", task_id: null, group_id: group.id, target_identity: `pr:${group.id}` },
  ]).concat(contributionTasks.flatMap((task: { id: string; group_id: string }) => [
    { id: `${task.id}-publish-branch`, kind: "publish_branch", task_id: task.id, group_id: null, target_identity: `branch:${task.id}` },
    { id: `${task.id}-publish-pr`, kind: "publish_pr", task_id: task.id, group_id: null, target_identity: `pr:${task.id}` },
  ]));
  for (const group of run.groups) {
    group.lifecycle.workspace_ready = "passed";
    run.events.push({
      id: `preview-${group.id}-workspace-ready`,
      type: "lifecycle_recorded",
      subject_id: group.id,
      actor_id: run.control.owner_thread_id,
      occurred_at: at,
      recorded_at: at,
      data: { target_type: "group", stage: "workspace_ready", resource_ids: [`${group.id}-worktree`, `${group.id}-branch`] },
    });
    run.resources.push(
      { id: `${group.id}-worktree`, kind: "worktree", target: group.id, status: "active", evidence_ref: `preview:${group.id}:worktree` },
      { id: `${group.id}-branch`, kind: "branch", target: group.parent_branch, status: "active", evidence_ref: `preview:${group.id}:branch` },
    );
    run.facts.push({
      id: `preview-${group.id}-branch-published`,
      kind: "branch_published",
      subject_id: group.id,
      status: "passed",
      source: "sample",
      observed_at: at,
      sha: group.current_sha,
      evidence_ref: `preview:${group.id}:branch-published`,
      receipt: {
        provider: run.repository.provider,
        repository: `${run.repository.owner}/${run.repository.name}`,
        resource_type: "branch",
        resource_id: group.parent_branch,
        branch: group.parent_branch,
        target_branch: null,
        base_sha: null,
        head_sha: group.current_sha,
        pr: null,
        state: "exists",
        evidence_ref: `preview:${group.id}:branch-published`,
      },
    });
    for (const event of run.events) {
      if (event.data && typeof event.data === "object" && "group_snapshot" in event.data && event.data.group_snapshot?.id === group.id) {
        event.data.group_snapshot = structuredClone(group);
      }
    }
  }
  return validateLedger(run);
}

/** Isolated runtime/archival example served through the real dashboard APIs. */
export function createIdleArchiveExample(referenceTime = Date.now()) {
  const original = createViewerValidationLedger(referenceTime);
  const bindings = new Map<string, string>();
  [original.control.owner_thread_id, ...original.groups.map(g => g.agent_thread_id), ...original.tasks.map(t => t.thread_id)].forEach((thread, index) => { if (thread) bindings.set(thread, `example-thread-${index}`); });
  const ledger = validateLedger(JSON.parse(JSON.stringify(original, (_key, value) => typeof value === "string" ? bindings.get(value) ?? value : value)));
  ledger.orchestration_id = "agent-idle-archive";
  ledger.notifications = [];
  ledger.follow_prs = [];
  const idle = ledger.tasks.find(t => t.id === "dashboard-ui")!;
  idle.state = "agent_idle";
  idle.agent_resume_state = "running";
  const at = new Date(referenceTime).toISOString();
  for (const taskId of ["model", "ledger"]) {
    const task = ledger.tasks.find(t => t.id === taskId)!;
    ledger.resources.push({ id: `example-archive-${taskId}`, kind: "conversation", target: task.thread_id!, status: taskId === "model" ? "archive_failed" : "archive_unknown", evidence_ref: `example:${taskId}`, error: taskId === "model" ? "示例：归档请求明确失败，可重新归档" : "示例：归档回执未知，可查询对账", last_attempt_at: at, operation_id: `example-attempt-${taskId}` });
  }
  const completed = ledger.tasks.find(task => task.id === "publish") ?? ledger.tasks.find(task => task.state === "completed" && task.thread_id)!;
  if (completed?.thread_id) ledger.resources.push({ id: "example-archive-success", kind: "conversation", target: completed.thread_id, status: "closed", evidence_ref: "example:archive-success", last_attempt_at: at });
  const archived = new Set<string>();
  const restored = new Set<string>();
  const archiveProvider: import("../../lib/conversation-archive").ArchiveProvider = {
    archive: async (thread) => { archived.add(thread); return { outcome: "succeeded", evidence_ref: "example:archive-success" }; },
    unarchive: async thread => { archived.delete(thread); restored.add(thread); return { outcome: "succeeded", evidence_ref: "example:unarchive-success" }; },
    isUnarchived: async thread => restored.has(thread),
    // The unknown fixture models a lost receipt whose archive is already complete.
    isArchived: async thread => archived.has(thread) || thread === ledger.tasks.find(t => t.id === "ledger")!.thread_id,
  };
  const connectObserver: import("../../lib/conversation-output").ConnectObserver = async () => ({
    request: async (method, params) => {
      if (method === "thread/read") return { thread: { status: { type: params?.threadId === idle.thread_id ? "idle" : "active" } } };
      if (method === "thread/turns/list") return { data: [{ id: "example-terminal-turn", status: "completed", items: [] }] };
      return { data: [] };
    },
    close() {},
  });
  return { ledger: validateLedger(ledger), dashboard: { connectObserver, archiveProvider, getProfileCapabilities: async () => [{ model: "gpt-6.1-sol", thinking: ["medium", "high"] }] } };
}
