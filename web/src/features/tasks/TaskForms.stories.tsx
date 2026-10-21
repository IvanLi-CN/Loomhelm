import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { expect, userEvent, within } from "storybook/test";

import { createStorySource } from "./story-source";
import { TaskEditor, TaskForm } from "./TaskForm";
import { TaskRelationshipEditor } from "./TaskRelations";

const meta = {
  title: "Product/TaskForms",
  component: TaskForm,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"]
} satisfies Meta<typeof TaskForm>;

export default meta;

type Story = StoryObj<typeof meta>;

function StoryFrame({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-[var(--canvas)] p-8" data-visual-evidence-surface><div className="mx-auto max-w-3xl" data-visual-evidence-target>{children}</div></div>;
}

export const Create: Story = {
  args: { source: createStorySource(), mode: "create" },
  render: (args) => <StoryFrame><TaskForm {...args} /></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = canvas.getByLabelText("任务标题");
    await userEvent.type(title, "新任务");
    expect(title).toHaveValue("新任务");
  }
};

export const Edit: Story = { args: { source: createStorySource(), mode: "edit", task: createStorySource().getTask("STORY-01") }, render: (args) => <StoryFrame><TaskForm {...args} /></StoryFrame> };

export const ReadOnly: Story = { args: { source: createStorySource({ canWrite: false, isReadOnly: true }), mode: "create" }, render: (args) => <StoryFrame><TaskForm {...args} /></StoryFrame> };

export const Relations: Story = { args: { source: createStorySource(), mode: "create" }, render: () => <StoryFrame><div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-5"><TaskRelationshipEditor source={createStorySource()} taskId="STORY-02" /></div></StoryFrame> };

export const ProtectedDelete: Story = {
  args: { source: createStorySource(), mode: "create" },
  render: () => <StoryFrame><div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-5"><TaskEditor source={createStorySource({ deleteTask: async () => ({ ok: false, code: "blocked", message: "任务已有对话或执行事实，受保护删除已阻止。" }) })} taskId="STORY-01" /></div></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "删除任务" }));
    expect(await canvas.findByText("任务已有对话或执行事实，受保护删除已阻止。"));
  }
};
