import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import type { Run, Session } from "@loomhelm/protocol";

import { RunStatusCard } from "./RunStatusCard";

const session: Session = {
  created_at: "2026-10-24T01:00:00Z",
  external_thread_ref: "thread-run",
  id: "ses-run-01",
  path: "new",
  state: "active",
  updated_at: "2026-10-24T01:12:00Z"
};

const baseRun: Run = {
  command_id: "cmd-run-01",
  created_at: "2026-10-24T01:11:00Z",
  id: "run-01",
  session_id: session.id,
  status: "running"
};

const meta = {
  title: "Features/Runs/Run Status",
  component: RunStatusCard,
  args: {
    run: baseRun,
    session
  },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "Run 状态把命令传输、实际事件、中断请求、实际终止、unknown 和断线区分开，不把请求中的中断伪装成终止。"
      }
    }
  },
  tags: ["autodocs"]
} satisfies Meta<typeof RunStatusCard>;

export default meta;

type Story = StoryObj<typeof meta>;

function EvidenceFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--canvas)] p-6 sm:p-8" data-visual-evidence-surface>
      <div className="mx-auto grid w-full max-w-5xl gap-5 md:grid-cols-2" data-visual-evidence-target>{children}</div>
    </div>
  );
}
function run(status: Run["status"], id: string): Run {
  return { ...baseRun, id, status };
}

export const StateGallery: Story = {
  render: () => (
    <EvidenceFrame>
      <RunStatusCard run={run("pending", "run-sending")} session={session} commandState="accepted" transport="sending" interruptCommandId="cmd-interrupt-sending" />
      <RunStatusCard run={run("pending", "run-received")} session={session} commandState="accepted" interruptCommandId="cmd-interrupt-received" />
      <RunStatusCard run={run("running", "run-executing")} session={session} commandState="executing" interruptCommandId="cmd-interrupt-executing" onInterrupt={() => undefined} />
      <RunStatusCard run={run("running", "run-interrupting")} session={session} interruptRequested commandState="executing" interruptCommandId="cmd-interrupting" onInterrupt={() => undefined} />
      <RunStatusCard run={run("interrupted", "run-terminated")} session={session} commandState="succeeded" interruptCommandId="cmd-interrupt-terminated" />
      <RunStatusCard run={run("unknown", "run-unknown")} session={session} commandState="unknown" interruptCommandId="cmd-interrupt-unknown" />
      <RunStatusCard run={run("running", "run-disconnected")} session={{ ...session, state: "disconnected" }} connection="offline" commandState="executing" interruptCommandId="cmd-interrupt-disconnected" />
    </EvidenceFrame>
  )
};

function InterruptHarness({ hold = false }: { hold?: boolean }) {
  const [status, setStatus] = useState<Run["status"]>("running");
  const [calls, setCalls] = useState(0);
  const sendInterrupt = async () => {
    setCalls((current) => current + 1);
    if (hold) return new Promise<void>(() => undefined);
    await Promise.resolve();
    setStatus("interrupted");
  };
  return (
    <>
      <RunStatusCard commandState="executing" interruptCommandId="cmd-interrupt-live" onInterrupt={sendInterrupt} run={{ ...baseRun, status }} session={session} />
      <output className="text-xs text-[var(--muted)]" data-testid="interrupt-count">已提交 {calls} 次中断请求</output>
    </>
  );
}

export const ExplicitInterrupt: Story = {
  render: () => (
    <EvidenceFrame>
      <div className="md:col-span-2"><InterruptHarness /></div>
    </EvidenceFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "请求中断" }));
    await expect(canvas.getByTestId("run-phase")).toHaveTextContent("实际终止");
    await expect(canvas.getByTestId("interrupt-count")).toHaveTextContent("已提交 1 次");
  }
};
export const DuplicateInterruptGuard: Story = {
  render: () => (
    <EvidenceFrame>
      <div className="md:col-span-2"><InterruptHarness hold /></div>
    </EvidenceFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", { name: "请求中断" });
    await userEvent.click(button);
    await userEvent.click(button);
    await expect(canvas.getByTestId("interrupt-count")).toHaveTextContent("已提交 1 次");
    await expect(canvas.getByRole("button", { name: "中断请求中" })).toBeDisabled();
    await expect(canvas.getByTestId("run-phase")).toHaveTextContent("中断请求中");
  }
};

export const OfflineControl: Story = {
  render: () => (
    <EvidenceFrame>
      <RunStatusCard connection="offline" commandState="executing" interruptCommandId="cmd-interrupt-offline" onInterrupt={() => undefined} run={baseRun} session={session} />
    </EvidenceFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("run-phase")).toHaveTextContent("已断线");
    await expect(canvas.getByRole("button", { name: "请求中断" })).toBeDisabled();
    await expect(canvas.getByText("不发送、不排队")).toBeInTheDocument();
  }
};
