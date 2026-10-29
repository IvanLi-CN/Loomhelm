import type { PublishedSessionApi } from "../sessions/api";
import type { Approval, Event, Run, Session } from "@loomhelm/protocol";

const session: Session = {
  created_at: "2026-10-29 13:42",
  external_thread_ref: "thread-demo-u03",
  id: "session-demo-u03",
  path: "new",
  project_id: "loomhelm",
  state: "active",
  task_id: "LH-30",
  updated_at: "2026-10-29 14:05"
};

const run: Run = {
  command_id: "run-demo-u03-command",
  created_at: "2026-10-29 14:04",
  id: "run-demo-u03",
  last_cursor: "u03-event-3",
  session_id: session.id,
  started_at: "2026-10-29 14:04",
  status: "waiting_approval"
};

const approval: Approval = {
  context: {
    command: "codex inspect --workspace /workspace/loomhelm --write-report",
    directory: "/workspace/loomhelm",
    impact: "读取当前任务上下文，并写入一份本地校验报告。"
  },
  id: "approval-demo-u03",
  kind: "workspace_access",
  requested_at: "2026-10-29 14:05",
  requested_event_id: "u03-event-3",
  revision: 2,
  run_id: run.id,
  status: "pending",
  summary: "允许读取 Loomhelm 工作区并写入校验报告"
};

const events: readonly Event[] = [
  {
    cursor: "u03-event-1",
    event_id: "u03-event-1",
    occurred_at: "2026-10-29 14:04",
    payload: { run_id: run.id },
    run_id: run.id,
    sequence: 1,
    session_id: session.id,
    source: "host-observation",
    type: "run.started"
  },
  {
    cursor: "u03-event-2",
    event_id: "u03-event-2",
    occurred_at: "2026-10-29 14:04",
    payload: { content: "我已读取任务与会话上下文，下一步需要确认工作区访问范围。" },
    run_id: run.id,
    sequence: 2,
    session_id: session.id,
    source: "app-server",
    type: "message.delta"
  },
  {
    cursor: "u03-event-3",
    event_id: "u03-event-3",
    occurred_at: "2026-10-29 14:05",
    payload: { approval_id: approval.id, revision: approval.revision, summary: approval.summary },
    run_id: run.id,
    sequence: 3,
    session_id: session.id,
    source: "host-observation",
    type: "approval.requested"
  }
];

const acceptedAck = (commandId: string, runId = run.id) => ({
  ack: {
    command_id: commandId,
    deduplicated: false,
    received_at: "2026-10-29 14:05",
    run_id: runId,
    state: "accepted" as const
  }
});

let demoDraftContent = "";
let demoDraftRevision = 0;

export function createProductionSessionDemoApi(): PublishedSessionApi {
  return {
    createSession: async ({ body }) => ({
      initial_run_ack: body.prompt ? {
        command_id: body.command_id,
        deduplicated: false,
        received_at: "2026-10-29 14:05",
        run_id: run.id,
        state: "accepted"
      } : undefined,
      session: {
        ...session,
        external_thread_ref: body.active_thread_ref ?? session.external_thread_ref,
        path: body.path,
        project_id: body.project_id,
        task_id: body.task_id
      }
    }),
    getDraft: async ({ session_id }) => ({ draft: { content: demoDraftContent, revision: demoDraftRevision, session_id, updated_at: "2026-10-29 14:05" } }),
    getArtifact: async () => {
      throw new Error("Demo artifact lookup is intentionally unavailable.");
    },
    getSession: async () => ({ session }),
    interruptRun: async ({ body }) => acceptedAck(body.command_id),
    listSessionRuns: async ({ session_id }) => ({ has_more: false, items: [{ ...run, session_id }] }),
    listRunApprovals: async () => ({ has_more: false, items: [approval] }),
    listRunEvents: async ({ after_cursor }) => ({
      events: after_cursor ? [] : events,
      has_more: false,
      next_cursor: events.at(-1)?.cursor
    }),
    resolveApproval: async ({ body }) => acceptedAck(body.command_id),
    submitRun: async ({ body }) => acceptedAck(body.command_id),
    updateDraft: async ({ body, session_id }) => {
      demoDraftContent = body.content;
      demoDraftRevision += 1;
      return { draft: { client_id: body.client_id, client_sequence: body.client_sequence, content: demoDraftContent, mutation_id: body.mutation_id, revision: demoDraftRevision, session_id, updated_at: "2026-10-29 14:05" } };
    }
  };
}
