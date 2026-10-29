import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, fn, userEvent, within } from "storybook/test";

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
    expect(args.onCreate).toHaveBeenCalledWith(expect.objectContaining({ path: "new", prompt: "先确认当前 Host 与 Session 边界。" }));
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
