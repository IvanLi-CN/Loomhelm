import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ReactNode } from "react";
import { expect, fn, userEvent, within } from "storybook/test";

import { TaskRelationPicker, type TaskRelationCandidate } from "./TaskRelationPicker";

const candidates: TaskRelationCandidate[] = Array.from({ length: 120 }, (_, index) => {
  const number = String(index + 1).padStart(4, "0");
  return {
    id: `TASK-${number}`,
    title: index === 117 ? "恢复跨项目任务关系并核对长标题" : `整理工作项 ${number}`,
    projectName: index % 2 === 0 ? "Loomhelm" : "Sidecar Notes"
  };
});

const meta = {
  title: "Product/TaskRelationPicker",
  component: TaskRelationPicker,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"]
} satisfies Meta<typeof TaskRelationPicker>;

export default meta;

type Story = StoryObj<typeof meta>;

const storyArgs = { label: "前置依赖", candidates, selectedIds: [], onChange: fn() };

function StoryFrame({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-[var(--canvas)] p-8" data-visual-evidence-surface><div className="mx-auto w-full max-w-xl" data-visual-evidence-target>{children}</div></div>;
}

function InteractivePicker({ initialSelected = [] }: { initialSelected?: string[] }) {
  const [selectedIds, setSelectedIds] = useState(initialSelected);
  return <TaskRelationPicker label="前置依赖" candidates={candidates} selectedIds={selectedIds} onChange={setSelectedIds} />;
}

export const SearchSelectRemove: Story = {
  args: storyArgs,
  render: () => <StoryFrame><InteractivePicker initialSelected={["TASK-0001"]} /></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("添加前置依赖"));
    const search = canvas.getByRole("searchbox", { name: "搜索任务 ID、标题或项目" });
    await userEvent.type(search, "TASK-0118");
    await userEvent.click(canvas.getByRole("checkbox", { name: /TASK-0118/ }));
    expect(canvas.getByRole("list", { name: "前置依赖已选任务" })).toHaveTextContent("TASK-0118");
    await userEvent.click(canvas.getByRole("button", { name: "移除前置依赖 TASK-0118" }));
    expect(canvas.getByRole("list", { name: "前置依赖已选任务" })).not.toHaveTextContent("TASK-0118");
  }
};

export const SearchAndCloseDoNotWrite: Story = {
  args: { ...storyArgs, label: "父任务" },
  render: (args) => <StoryFrame><TaskRelationPicker {...args} /></StoryFrame>,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("添加父任务"));
    await userEvent.type(canvas.getByRole("searchbox", { name: "搜索任务 ID、标题或项目" }), "不存在的任务");
    expect(canvas.getByRole("status", { name: "未找到匹配任务。" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(canvas.getByRole("button", { name: "添加父任务" })).toHaveFocus();
    expect(args.onChange).not.toHaveBeenCalled();
  }
};

export const LongListIsBounded: Story = {
  args: storyArgs,
  render: () => <StoryFrame><InteractivePicker /></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("添加前置依赖"));
    expect(canvas.getByText("已显示 40 / 120")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "显示更多（还有 80 项）" }));
    expect(canvas.getByText("已显示 80 / 120")).toBeInTheDocument();
  }
};

export const PermissionAndPending: Story = {
  args: storyArgs,
  render: () => <StoryFrame><TaskRelationPicker label="前置依赖" candidates={candidates.slice(0, 3).map((candidate) => ({ ...candidate, disabled: true, disabledReason: "当前关系端点只读，关系不可修改" }))} selectedIds={["TASK-0001"]} selectedCandidates={[{ ...candidates[0], disabled: true, disabledReason: "当前关系端点只读，关系不可修改" }]} onChange={fn()} disabled disabledMessage="关系保存中，暂时不能修改。" /></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("status", { name: "关系保存中，暂时不能修改。" })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "移除前置依赖 TASK-0001" })).toBeDisabled();
    expect(canvas.getByRole("button", { name: "添加前置依赖" })).toHaveAttribute("aria-disabled", "true");
  }
};
