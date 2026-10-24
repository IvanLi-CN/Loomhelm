import type { Meta, StoryObj } from "@storybook/react-vite";

import type { Session, Task } from "@loomhelm/protocol";

import { SessionContextSummary } from "./SessionContextSummary";

const standaloneSession: Session = {
  created_at: "2026-10-24T01:00:00Z",
  external_thread_ref: "thread-standalone",
  id: "ses-standalone-01",
  path: "new",
  state: "active",
  updated_at: "2026-10-24T01:12:00Z"
};

const task: Task = {
  created_at: "2026-10-23T23:00:00Z",
  goal: "把候选版本的执行事实和审批上下文留在同一任务主会话中。",
  id: "LH-30",
  project_id: "loomhelm",
  session_id: "ses-task-main-01",
  status: "in_progress",
  title: "核对蓝绿发布候选",
  updated_at: "2026-10-24T01:10:00Z"
};

const taskSession: Session = {
  created_at: "2026-10-23T23:02:00Z",
  external_thread_ref: "thread-task-main",
  id: "ses-task-main-01",
  path: "existing_active",
  project_id: "loomhelm",
  state: "active",
  task_id: task.id,
  updated_at: "2026-10-24T01:12:00Z"
};

const meta = {
  title: "Features/Sessions/Session Context",
  component: SessionContextSummary,
  args: {
    context: {
      conversationTitle: "独立研究会话",
      session: standaloneSession
    }
  },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "用同一 Session 视图明确区分独立会话和任务主会话；连接、Desktop 接入与任务业务状态保持独立。"
      }
    }
  },
  tags: ["autodocs"]
} satisfies Meta<typeof SessionContextSummary>;

export default meta;

type Story = StoryObj<typeof meta>;

function EvidenceFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--canvas)] p-6 sm:p-8" data-visual-evidence-surface>
      <div className="mx-auto grid w-full max-w-5xl gap-5" data-visual-evidence-target>{children}</div>
    </div>
  );
}
export const ContextGallery: Story = {
  render: () => (
    <EvidenceFrame>
      <SessionContextSummary
        context={{
          conversationTitle: "先梳理用户路径",
          session: standaloneSession
        }}
      />
      <SessionContextSummary
        context={{
          conversationTitle: "核对蓝绿发布候选",
          projectName: "Loomhelm",
          session: taskSession,
          task
        }}
      />
    </EvidenceFrame>
  )
};
export const Standalone: Story = {
  render: () => (
    <EvidenceFrame>
      <SessionContextSummary context={{ conversationTitle: "独立研究会话", session: standaloneSession }} />
    </EvidenceFrame>
  )
};

export const TaskMain: Story = {
  render: () => (
    <EvidenceFrame>
      <SessionContextSummary context={{ conversationTitle: task.title, projectName: "Loomhelm", session: taskSession, task }} />
    </EvidenceFrame>
  )
};

export const Disconnected: Story = {
  render: () => (
    <EvidenceFrame>
      <SessionContextSummary
        connection="offline"
        context={{
          conversationTitle: "断线后的任务主会话",
          projectName: "Loomhelm",
          session: { ...taskSession, state: "disconnected" },
          task
        }}
      />
    </EvidenceFrame>
  )
};
export const UnsupportedDesktop: Story = {
  render: () => (
    <EvidenceFrame>
      <SessionContextSummary
        connection="online"
        context={{
          conversationTitle: "现有 Desktop 活跃会话",
          session: { ...standaloneSession, path: "existing_active", state: "unsupported" }
        }}
      />
    </EvidenceFrame>
  )
};
