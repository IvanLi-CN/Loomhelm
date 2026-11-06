import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import type { ResolveApprovalParams } from "@loomhelm/api-client";
import type { Approval } from "@loomhelm/protocol";

import { ApprovalRequestCard, type ApprovalRequestModel } from "./ApprovalRequestCard";

const baseApproval: Approval = {
  id: "approval-remote-write-01",
  kind: "workspace.write",
  requested_at: "2026-10-24T01:10:00Z",
  revision: 4,
  run_id: "run-approval-01",
  status: "pending",
  summary: "允许读取并写入 Loomhelm 工作区"
};

const request: ApprovalRequestModel = {
  approval: baseApproval,
  context: {
    command: "codex inspect --workspace /workspace/loomhelm --write-report",
    conversationTitle: "审批远程工作区变更",
    directory: "/workspace/loomhelm",
    impact: "会读取当前任务上下文，并写入一份本地校验报告。",
    projectName: "Loomhelm",
    sessionId: "ses-approval-01",
    task: { id: "LH-30", title: "核对蓝绿发布候选" }
  }
};
const meta = {
  title: "Features/Approvals/Approval Request",
  component: ApprovalRequestCard,
  args: {
    request
  },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "审批请求完整展示命令、目录、影响范围、Session/Run/任务上下文和当前修订；旧修订、已处理、过期、只读与断线状态不可操作。"
      }
    }
  },
  tags: ["autodocs"]
} satisfies Meta<typeof ApprovalRequestCard>;

export default meta;

type Story = StoryObj<typeof meta>;

function EvidenceFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[976px] bg-[var(--canvas)] p-6 sm:p-10" data-visual-evidence-surface>
      <div className="mx-auto grid w-full max-w-4xl gap-5 lg:grid-cols-2" data-visual-evidence-target>{children}</div>
    </div>
  );
}
export const StateGallery: Story = {
  render: () => (
    <EvidenceFrame>
      <ApprovalRequestCard commandIds={{ approve: "cmd-approve-01", deny: "cmd-deny-01" }} onResolve={() => undefined} request={request} />
      <ApprovalRequestCard request={{ ...request, approval: { ...baseApproval, status: "approved" } }} />
      <ApprovalRequestCard request={{ ...request, approval: { ...baseApproval, status: "denied" } }} />
      <ApprovalRequestCard request={{ ...request, approval: { ...baseApproval, revision: 5, status: "expired" } }} />
      <div className="lg:col-span-2">
        <ApprovalRequestCard commandIds={{ approve: "cmd-approve-readonly", deny: "cmd-deny-readonly" }} readOnly onResolve={() => undefined} request={{ ...request, approval: { ...baseApproval, id: "approval-readonly" } }} />
      </div>
    </EvidenceFrame>
  )
};

function ApprovalHarness({ hold = false }: { hold?: boolean }) {
  const [status, setStatus] = useState<Approval["status"]>("pending");
  const [calls, setCalls] = useState<ResolveApprovalParams[]>([]);
  const resolve = async (params: ResolveApprovalParams) => {
    setCalls((current) => [...current, params]);
    if (hold) return new Promise<void>(() => undefined);
    await Promise.resolve();
    setStatus(params.body.decision === "approve" ? "approved" : "denied");
  };
  return (
    <>
      <ApprovalRequestCard commandIds={{ approve: "cmd-approve-live", deny: "cmd-deny-live" }} onResolve={resolve} request={{ ...request, approval: { ...baseApproval, status } }} />
      <output className="text-xs text-[var(--muted)]" data-testid="approval-count">已提交 {calls.length} 次决定</output>
    </>
  );
}

export const ExplicitDecision: Story = {
  render: () => (
    <EvidenceFrame>
      <ApprovalHarness />
    </EvidenceFrame>
  ),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "批准" }));
    await expect(canvas.getByTestId("approval-status")).toHaveTextContent("已批准");
    await expect(canvas.getByTestId("approval-count")).toHaveTextContent("已提交 1 次");
  }
};

export const NonObjectContext: Story = {
  render: () => (
    <EvidenceFrame>
      <ApprovalRequestCard
        request={{
          ...request,
          context: {
            ...request.context,
            command: request.approval.summary,
            complete: false,
            rawContext: '[{"type":"text","text":"opaque request"}]'
          }
        }}
      />
    </EvidenceFrame>
  )
};

export const DuplicateDecisionGuard: Story = {
  render: () => (
    <EvidenceFrame>
      <ApprovalHarness hold />
    </EvidenceFrame>
  ),
  play: async ({ canvas, userEvent }) => {
    const button = canvas.getByRole("button", { name: "批准" });
    await userEvent.click(button);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await expect(canvas.getByTestId("approval-count")).toHaveTextContent("已提交 1 次");
    await expect(canvas.getByRole("button", { name: "正在批准" })).toBeDisabled();
  }
};

export const ExpiredCannotAct: Story = {
  render: () => (
    <EvidenceFrame>
      <ApprovalRequestCard commandIds={{ approve: "cmd-expired-approve", deny: "cmd-expired-deny" }} request={{ ...request, approval: { ...baseApproval, revision: 3, status: "expired" } }} />
    </EvidenceFrame>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "批准" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "拒绝" })).toBeDisabled();
    await expect(canvas.getByText("当前请求已过期，不能再次操作。")).toBeInTheDocument();
  }
};

export const OfflineCannotQueue: Story = {
  render: () => (
    <EvidenceFrame>
      <ApprovalRequestCard connection="offline" commandIds={{ approve: "cmd-offline-approve", deny: "cmd-offline-deny" }} onResolve={() => undefined} request={request} />
    </EvidenceFrame>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "批准" })).toBeDisabled();
    await expect(canvas.getByText("已断线，审批不会发送或排队。")).toBeInTheDocument();
  }
};

export const IncompleteContextCannotAct: Story = {
  render: () => (
    <EvidenceFrame>
      <ApprovalRequestCard commandIds={{ approve: "cmd-incomplete-approve", deny: "cmd-incomplete-deny" }} onResolve={() => undefined} request={{ ...request, context: { ...request.context, complete: false } }} />
    </EvidenceFrame>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("请求上下文不完整")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "批准" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "拒绝" })).toBeDisabled();
  }
};

export const FileChangeScopeContext: Story = {
  render: () => (
    <EvidenceFrame>
      <ApprovalRequestCard commandIds={{ approve: "cmd-file-change-approve", deny: "cmd-file-change-deny" }} onResolve={() => undefined} request={{ ...request, approval: { ...baseApproval, kind: "file_change", summary: "Review workspace file changes" }, context: { ...request.context, directory: undefined, impact: "A file change is ready for review", scope: "workspace" } }} />
    </EvidenceFrame>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("范围：workspace")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "批准" })).toBeEnabled();
  }
};

export const UnknownContextVisible: Story = {
  render: () => (
    <EvidenceFrame>
      <ApprovalRequestCard commandIds={{ approve: "cmd-unknown-approve", deny: "cmd-unknown-deny" }} onResolve={() => undefined} request={{ ...request, context: { ...request.context, rawContext: JSON.stringify({ command: request.context.command, scope: "workspace", payload: { write: true } }, null, 2) } }} />
    </EvidenceFrame>
  ),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByText("查看未识别上下文原文"));
    await expect(canvas.getByText(/"scope": "workspace"/)).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "批准" })).toBeEnabled();
  }
};
