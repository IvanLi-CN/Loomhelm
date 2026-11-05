import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, fn, userEvent, waitFor, within } from "storybook/test";
import type { CreateSessionRequest } from "@loomhelm/protocol";

import { ProductionSessionCreationPanel } from "./ProductionConversationWorkspace";

const meta = {
  title: "Features/Conversations/Production Session Creation",
  component: ProductionSessionCreationPanel,
  args: {
    onCreate: fn(),
    principalId: "storybook",
    projectOptions: [
      { id: "loomhelm", name: "Loomhelm" },
      { id: "codex", name: "Codex 兼容性" }
    ]
  },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "生产会话创建入口明确展示 Host 路径、可选项目、现有 thread ref 与首条提示；创建只提交一次命令，不把草稿伪装成已接收消息。"
      }
    }
  },
  tags: ["autodocs"]
} satisfies Meta<typeof ProductionSessionCreationPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

function EvidenceFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--canvas)] p-6 sm:p-10" data-visual-evidence-surface>
      <div className="mx-auto grid w-full max-w-3xl gap-5" data-visual-evidence-target>{children}</div>
    </div>
  );
}

export const StateGallery: Story = {
  render: (args) => (
    <EvidenceFrame>
      <ProductionSessionCreationPanel {...args} conversationTitle="独立研究会话" />
      <ProductionSessionCreationPanel {...args} conversationTitle="接入任务主会话" fixedProjectId="loomhelm" fixedProjectName="Loomhelm" taskId="LH-30" />
      <ProductionSessionCreationPanel {...args} conversationTitle="只读会话" readOnly />
    </EvidenceFrame>
  )
};

export const ExplicitCreate: Story = {
  args: {
    onCreate: fn()
  },
  render: (args) => (
    <EvidenceFrame>
      <ProductionSessionCreationPanel {...args} />
    </EvidenceFrame>
  ),
  play: async ({ args, canvas }) => {
    fireEvent.change(canvas.getByRole("textbox", { name: "首条提示（可选）" }), { target: { value: "先确认当前 Host 与 Session 边界。" } });
    await userEvent.click(canvas.getByRole("button", { name: "创建会话" }));
    await expect(args.onCreate).toHaveBeenCalledOnce();
    expect(args.onCreate).toHaveBeenCalledWith(expect.objectContaining({ path: "new", prompt: "先确认当前 Host 与 Session 边界。" }), expect.any(Function));
  }
};

const unknownSessionCreation = fn(async (_request: CreateSessionRequest, _beforeCommit?: () => boolean | Promise<boolean>) => {
  throw new Error("session creation result is unknown in story");
});

const storageFailureSessionCreation = fn(async (_request: CreateSessionRequest, _beforeCommit?: () => boolean | Promise<boolean>) => {
  throw new Error("session creation result is unknown in storage failure story");
});

export const UnknownResultCanRetrySameCommand: Story = {
  args: {
    onCreate: unknownSessionCreation,
    principalId: "storybook-unknown-result"
  },
  render: (args) => (
    <EvidenceFrame>
      <ProductionSessionCreationPanel {...args} conversationTitle="未知结果重试" />
    </EvidenceFrame>
  ),
  play: async ({ args, canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: "创建会话" }));
    const retryButton = await canvas.findByRole("button", { name: "重试同一命令" });
    await expect(retryButton).toBeEnabled();
    await userEvent.click(retryButton);
    await waitFor(() => expect(args.onCreate).toHaveBeenCalledTimes(2));
    expect(unknownSessionCreation.mock.calls[1]?.[0]).toEqual(unknownSessionCreation.mock.calls[0]?.[0]);
    await expect(canvas.findByRole("button", { name: "重试同一命令" })).resolves.toBeEnabled();
  }
};

export const UnknownResultStorageFailureKeepsReconciliationState: Story = {
  args: {
    onCreate: storageFailureSessionCreation,
    principalId: "storybook-storage-failure"
  },
  render: (args) => (
    <EvidenceFrame>
      <ProductionSessionCreationPanel {...args} conversationTitle="未知结果存储失败" />
    </EvidenceFrame>
  ),
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: "创建会话" }));
    const retryButton = await canvas.findByRole("button", { name: "重试同一命令" });
    const setItemDescriptor = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem");
    try {
      Object.defineProperty(Storage.prototype, "setItem", { configurable: true, value: () => { throw new Error("storage blocked"); } });
      await userEvent.click(retryButton);
      await expect(canvas.findByRole("status")).resolves.toHaveTextContent("创建结果不确定");
      expect(canvas.getByRole("status")).not.toHaveTextContent("创建请求尚未发送");
    } finally {
      if (setItemDescriptor) Object.defineProperty(Storage.prototype, "setItem", setItemDescriptor);
      for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = window.sessionStorage.key(index);
        if (key?.includes("storybook-storage-failure")) window.sessionStorage.removeItem(key);
      }
    }
  }
};

export const ExistingActiveHost: Story = {
  args: {
    existingActiveSupported: true
  },
  render: (args) => (
    <EvidenceFrame>
      <ProductionSessionCreationPanel {...args} />
    </EvidenceFrame>
  ),
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("combobox", { name: "Host 路径" }));
    await userEvent.click(within(document.body).getByRole("option", { name: "接入现有活跃对话" }));
    await expect(canvas.getByRole("textbox", { name: "现有 Host thread ref" })).toBeInTheDocument();
  }
};

export const ExistingActiveUnavailable: Story = {
  render: (args) => (
    <EvidenceFrame>
      <ProductionSessionCreationPanel {...args} />
    </EvidenceFrame>
  ),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("combobox", { name: "Host 路径" }));
    await userEvent.click(within(document.body).getByRole("option", { name: "接入现有活跃对话" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("当前后端尚未支持 existing_active");
    await expect(canvas.getByRole("button", { name: "创建会话" })).toBeDisabled();
  }
};

export const ReadOnlyProjectOptions: Story = {
  render: (args) => (
    <EvidenceFrame>
      <ProductionSessionCreationPanel {...args} projectCanWrite={(projectId) => projectId === "loomhelm"} />
    </EvidenceFrame>
  ),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("combobox", { name: "项目" }));
    await expect(within(document.body).getByRole("option", { name: "Codex 兼容性（只读）" })).toBeDisabled();
  }
};
