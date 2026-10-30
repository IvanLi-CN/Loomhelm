import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Artifact, Event } from "@loomhelm/protocol";

import { createProductionSessionDemoApi } from "./production-session-demo-api";
import { ProductionConversationWorkspace } from "./ProductionConversationWorkspace";

const meta = {
  title: "Features/Conversations/Production Workspace",
  component: ProductionConversationWorkspace,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "完整生产会话工作区覆盖 Session 上下文、Run 事件、审批历史、消息流和控制 Composer；数据来自 mock-only 适配层。"
      }
    }
  },
  tags: ["autodocs"]
} satisfies Meta<typeof ProductionConversationWorkspace>;

export default meta;

type Story = StoryObj<typeof meta>;

function EvidenceFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--canvas)] p-6 sm:p-10" data-visual-evidence-surface>
      <div className="mx-auto grid w-full max-w-5xl gap-5" data-visual-evidence-target>{children}</div>
    </div>
  );
}

function ProductionWorkspaceStory() {
  const api = useMemo(() => createProductionSessionDemoApi(), []);
  return (
    <EvidenceFrame>
      <ProductionConversationWorkspace
        api={api}
        conversationTitle="整理远程工作区边界"
        initialRunId="run-demo-u03"
        principalId="storybook"
        projectId="loomhelm"
        projectName="Loomhelm"
        sessionId="session-demo-u03"
        task={{ goal: "确认当前 Host 与 Session 的执行边界。", id: "LH-30", state: "进行中", title: "整理远程工作区边界" }}
      />
    </EvidenceFrame>
  );
}

const contentArtifact: Artifact = {
  content_type: "text/markdown",
  created_at: "2026-10-29 14:05",
  id: "artifact-demo-u03-report",
  kind: "file",
  name: "reports/summary.md",
  run_id: "run-demo-u03",
  session_id: "session-demo-u03",
  sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  size: 68
};

const contentEvents: readonly Event[] = [
  {
    cursor: "u04-content-event-1",
    event_id: "u04-content-event-1",
    occurred_at: "2026-10-29 14:04",
    payload: { run_id: "run-demo-u03" },
    run_id: "run-demo-u03",
    sequence: 1,
    session_id: "session-demo-u03",
    source: "host-observation",
    type: "run.started"
  },
  {
    cursor: "u04-content-event-2",
    event_id: "u04-content-event-2",
    occurred_at: "2026-10-29 14:04",
    payload: { content: "我已读取任务与会话上下文，接下来展示可验证的消息、代码和工具事件。" },
    run_id: "run-demo-u03",
    sequence: 2,
    session_id: "session-demo-u03",
    source: "app-server",
    type: "message.delta"
  },
  {
    cursor: "u04-content-event-3",
    event_id: "u04-content-event-3",
    occurred_at: "2026-10-29 14:04",
    payload: { params: { item: { id: "u04-agent-message", text: "消息会保留在当前 Session，并按服务端事件顺序合并。", type: "agentMessage" } } },
    run_id: "run-demo-u03",
    sequence: 3,
    session_id: "session-demo-u03",
    source: "app-server",
    type: "item.completed"
  },
  {
    cursor: "u04-content-event-4",
    event_id: "u04-content-event-4",
    occurred_at: "2026-10-29 14:04",
    payload: { params: { item: { code: "await workspace.read(\"reports/summary.md\");", language: "typescript", path: "/workspace/loomhelm/reports/summary.md", type: "code" } } },
    run_id: "run-demo-u03",
    sequence: 4,
    session_id: "session-demo-u03",
    source: "app-server",
    type: "item.completed"
  },
  {
    cursor: "u04-content-event-5",
    event_id: "u04-content-event-5",
    occurred_at: "2026-10-29 14:04",
    payload: { method: "item/commandExecution/outputDelta", params: { delta: "读取完成：1 个授权文件，未扩大工作区范围。" } },
    run_id: "run-demo-u03",
    sequence: 5,
    session_id: "session-demo-u03",
    source: "host-observation",
    type: "message.delta"
  },
  {
    cursor: "u04-content-event-6",
    event_id: "u04-content-event-6",
    occurred_at: "2026-10-29 14:05",
    payload: { artifact_id: contentArtifact.id },
    run_id: "run-demo-u03",
    sequence: 6,
    session_id: "session-demo-u03",
    source: "artifact",
    type: "artifact.created"
  },
  {
    cursor: "u04-content-event-7",
    event_id: "u04-content-event-7",
    occurred_at: "2026-10-29 14:05",
    payload: { approval_id: "approval-demo-u03", revision: 2, summary: "允许读取 Loomhelm 工作区并写入校验报告" },
    run_id: "run-demo-u03",
    sequence: 7,
    session_id: "session-demo-u03",
    source: "host-observation",
    type: "approval.requested"
  }
];

function ProductionContentWorkspaceStory() {
  const api = useMemo(() => createProductionSessionDemoApi({ artifacts: { [contentArtifact.id]: contentArtifact }, events: contentEvents }), []);
  return (
    <EvidenceFrame>
      <ProductionConversationWorkspace
        api={api}
        conversationTitle="展示会话内容与文件产物"
        initialRunId="run-demo-u03"
        principalId="storybook-content"
        projectId="loomhelm"
        projectName="Loomhelm"
        sessionId="session-demo-u03"
        task={{ goal: "验证消息、代码、工具事件与文件产物在生产工作区中的可读投影。", id: "LH-30", state: "进行中", title: "展示会话内容与文件产物" }}
      />
    </EvidenceFrame>
  );
}

export const WaitingForApproval: Story = {
  render: () => <ProductionWorkspaceStory />
};

export const ContentAndArtifact: Story = {
  render: () => <ProductionContentWorkspaceStory />
};
