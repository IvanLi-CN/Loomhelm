import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

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
        projectId="loomhelm"
        projectName="Loomhelm"
        sessionId="session-demo-u03"
        task={{ goal: "确认当前 Host 与 Session 的执行边界。", id: "LH-30", state: "进行中", title: "整理远程工作区边界" }}
      />
    </EvidenceFrame>
  );
}

export const WaitingForApproval: Story = {
  render: () => <ProductionWorkspaceStory />
};
