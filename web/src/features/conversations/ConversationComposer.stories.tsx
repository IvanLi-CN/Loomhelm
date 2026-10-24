import { useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { ConversationComposer } from "./ConversationMessageStream";

const meta = {
  title: "Features/Conversations/Composer",
  component: ConversationComposer,
  args: {
    onChange: () => undefined,
    onSend: () => undefined,
    value: ""
  },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "Composer 允许离线编辑草稿，但在断线、恢复中、只读或提交进行中不会发送或排队；一次提交只消费当前文本。"
      }
    }
  },
  tags: ["autodocs"]
} satisfies Meta<typeof ConversationComposer>;

export default meta;

type Story = StoryObj<typeof meta>;

function EvidenceFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--canvas)] p-6 sm:p-8" data-visual-evidence-surface>
      <div className="mx-auto grid w-full max-w-2xl gap-5" data-visual-evidence-target>{children}</div>
    </div>
  );
}
function ComposerHarness({ connection = "online", holdSubmission = false, readOnly = false }: { connection?: "online" | "offline" | "reconnecting"; holdSubmission?: boolean; readOnly?: boolean }) {
  const [draft, setDraft] = useState("补充当前执行的验证范围");
  const [sent, setSent] = useState<string[]>([]);
  const pending = useRef<Promise<void> | null>(null);
  const send = (value: string) => {
    setSent((current) => [...current, value]);
    if (holdSubmission) {
      pending.current = new Promise(() => undefined);
      return pending.current;
    }
    setDraft("");
    return Promise.resolve();
  };

  return (
    <>
      <ConversationComposer connection={connection} onChange={setDraft} onSend={send} readOnly={readOnly} value={draft} />
      <output className="text-xs text-[var(--muted)]" data-testid="sent-count">已提交 {sent.length} 次</output>
    </>
  );
}

export const OnlineSubmit: Story = {
  render: () => (
    <EvidenceFrame>
      <ComposerHarness />
    </EvidenceFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "发送" }));
    await expect(canvas.getByTestId("sent-count")).toHaveTextContent("已提交 1 次");
  }
};

export const DuplicateClickGuard: Story = {
  render: () => (
    <EvidenceFrame>
      <ComposerHarness holdSubmission />
    </EvidenceFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", { name: "发送" });
    await userEvent.click(button);
    await userEvent.click(button);
    await expect(canvas.getByTestId("sent-count")).toHaveTextContent("已提交 1 次");
    await expect(canvas.getByRole("button", { name: "发送中" })).toBeDisabled();
  }
};

export const OfflineDraft: Story = {
  render: () => (
    <EvidenceFrame>
      <ComposerHarness connection="offline" />
    </EvidenceFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", { name: "发送" });
    await expect(button).toBeDisabled();
    await userEvent.click(button);
    await expect(canvas.getByTestId("sent-count")).toHaveTextContent("已提交 0 次");
    await expect(canvas.getByText("不会发送或排队草稿")).toBeInTheDocument();
  }
};

export const ReadOnly: Story = {
  render: () => (
    <EvidenceFrame>
      <ComposerHarness readOnly />
    </EvidenceFrame>
  )
};
