import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { expect, userEvent, within } from "storybook/test";

import { createStorySource, storyTasks } from "./story-source";
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

function knownCreationSource() {
  const taskId = "task_0123456789abcdef0123456789abcdef";
  const source = createStorySource({ pendingTaskCreation: true, pendingTaskCreationResourceId: taskId, isTaskReconciliationReady: (id) => id === taskId });
  source.acknowledgeTaskReconciliation = (id) => {
    if (id !== taskId) return false;
    source.pendingTaskCreation = false;
    delete source.pendingTaskCreationResourceId;
    return true;
  };
  return source;
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

export const KnownCreationRecovery: Story = {
  args: { source: knownCreationSource(), mode: "create" },
  render: (args) => <StoryFrame><TaskForm {...args} /></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "刷新并核对任务列表" }));
    expect(await canvas.findByText("已刷新并核对预选任务，可以确认当前状态后解除阻塞。")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "确认当前任务状态，解除阻塞" }));
    expect(await canvas.findByText("已确认当前任务状态，可以继续操作。")).toBeInTheDocument();
  }
};

export const Edit: Story = { args: { source: createStorySource(), mode: "edit", task: createStorySource().getTask("STORY-01") }, render: (args) => <StoryFrame><TaskForm {...args} /></StoryFrame> };

export const ReadOnly: Story = { args: { source: createStorySource({ getProjectPermissions: () => ({ role: "viewer", canWrite: false, canManageProjects: false, isReadOnly: true }), canCreateProjects: false }), mode: "create" }, render: (args) => <StoryFrame><TaskForm {...args} /></StoryFrame> };

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

export const ReconciliationBlocked: Story = {
  args: { source: createStorySource(), mode: "edit" },
  render: () => {
    const task = { ...storyTasks[0], relationshipsConfirmed: false, reconciliationNotice: "关系写入结果待核对；请先刷新列表。" };
    const source = createStorySource({ tasks: [task, ...storyTasks.slice(1)], getTask: (id) => id === task.id ? task : storyTasks.find((item) => item.id === id) });
    return <StoryFrame><TaskEditor source={source} taskId={task.id} /></StoryFrame>;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("alert")).toHaveTextContent("关系写入结果待核对");
    expect(canvas.getByRole("button", { name: "编辑任务" })).toBeDisabled();
    expect(canvas.getByRole("button", { name: "删除任务" })).toBeDisabled();
  }
};

export const RelationWritePending: Story = {
  args: { source: createStorySource(), mode: "edit" },
  render: () => {
    const source = createStorySource({ isTaskRelationWritePending: (taskId) => taskId === "STORY-01" });
    return <StoryFrame><div className="grid gap-4"><TaskEditor source={source} taskId="STORY-01" /><TaskRelationshipEditor source={source} taskId="STORY-01" /></div></StoryFrame>;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("任务关系保存中，编辑和删除暂时不可用。")).toBeInTheDocument();
    expect(canvas.getByText("关系保存中…")).toBeInTheDocument();
  }
};
