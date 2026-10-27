import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { expect, fn, userEvent, within } from "storybook/test";

import { createStorySource, storyTasks } from "./story-source";
import { TaskEditor, TaskForm } from "./TaskForm";
import { TaskRelationshipEditor } from "./TaskRelations";
import type { TaskRecord } from "./types";

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

function pendingCreationSource() {
  const source = createStorySource();
  const noticeId = "task:create:story";
  source.pendingTaskCreation = true;
  source.pendingTaskCreationNoticeId = noticeId;
  source.isPendingTaskCreationReady = (id) => id === noticeId;
  source.acknowledgePendingTaskCreation = (id) => {
    if (id !== noticeId) return false;
    source.pendingTaskCreation = false;
    delete source.pendingTaskCreationNoticeId;
    return true;
  };
  return source;
}

function incompleteKnownCreationSource() {
  const source = knownCreationSource();
  source.isTaskReconciliationReady = () => false;
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

export const MobileCreate: Story = {
  ...Create,
  parameters: {
    viewport: {
      options: {
        taskFormsMobile: {
          name: "TaskForms mobile 393x852",
          styles: { width: "393px", height: "852px" },
          type: "mobile"
        }
      }
    }
  },
  globals: { viewport: "taskFormsMobile" }
};

export const KnownCreationRecovery: Story = {
  args: { source: knownCreationSource(), mode: "create", onSaved: fn() },
  render: (args) => <StoryFrame><TaskForm {...args} /></StoryFrame>,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "刷新并核对任务列表" }));
    expect(await canvas.findByText("已刷新并核对预选任务，可以确认当前状态后解除阻塞。")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "确认当前任务状态，解除阻塞" }));
    expect(await canvas.findByText("已确认当前任务状态，可以继续操作。")).toBeInTheDocument();
    expect(args.onSaved).toHaveBeenCalledWith("task_0123456789abcdef0123456789abcdef");
    expect(canvas.getByRole("form", { name: "创建任务" })).toHaveFocus();
  }
};

export const PendingCreationRecovery: Story = {
  args: { source: pendingCreationSource(), mode: "create" },
  render: (args) => <StoryFrame><TaskForm {...args} /></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText("上一次任务创建结果仍待确认；请先检查任务列表，当前表单不会再次提交。")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "刷新并核对任务列表" }));
    expect(await canvas.findByText("列表已刷新，但本次任务创建结果仍待确认；为避免重复创建，当前表单不会再次提交。")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "确认未创建，允许重新提交" }));
    expect(await canvas.findByText("已确认任务列表中没有这次写入，可以重新提交。")).toBeInTheDocument();
    expect(canvas.getByRole("form", { name: "创建任务" })).toHaveFocus();
  }
};

export const KnownCreationIncompleteRefresh: Story = {
  args: { source: incompleteKnownCreationSource(), mode: "create" },
  render: (args) => <StoryFrame><TaskForm {...args} /></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "刷新并核对任务列表" }));
    expect(await canvas.findByText("列表已刷新，但预选任务写入仍在进行或尚未完成确认；请稍后再次刷新。")).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "确认当前任务状态，解除阻塞" })).not.toBeInTheDocument();
  }
};

export const KnownCreationRefreshFailure: Story = {
  args: { source: createStorySource({ ...knownCreationSource(), refresh: async () => { throw new Error("模拟刷新失败"); } }), mode: "create" },
  render: (args) => <StoryFrame><TaskForm {...args} /></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "刷新并核对任务列表" }));
    expect(await canvas.findByText("刷新任务列表失败：模拟刷新失败")).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "确认当前任务状态，解除阻塞" })).not.toBeInTheDocument();
  }
};

export const Edit: Story = { args: { source: createStorySource(), mode: "edit", task: createStorySource().getTask("STORY-01") }, render: (args) => <StoryFrame><TaskForm {...args} /></StoryFrame> };

export const EditWithRelations: Story = {
  args: {
    source: createStorySource(),
    mode: "edit",
    task: { ...storyTasks[1], parentIds: ["STORY-01"], dependsOn: ["STORY-01"] }
  },
  render: (args) => <StoryFrame><TaskForm {...args} /></StoryFrame>
};

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
    const task: TaskRecord = { ...storyTasks[0], relationshipsConfirmed: false, reconciliationNotice: "关系写入结果待核对；请先刷新列表。" };
    const source = createStorySource({
      tasks: [task, ...storyTasks.slice(1)],
      getTask: (id) => id === task.id ? task : storyTasks.find((item) => item.id === id),
      isTaskReconciliationReady: (id) => id === task.id,
      acknowledgeTaskReconciliation: (id) => {
        if (id !== task.id) return false;
        task.relationshipsConfirmed = true;
        task.reconciliationNotice = undefined;
        return true;
      }
    });
    return <StoryFrame><TaskEditor source={source} taskId={task.id} /></StoryFrame>;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("alert")).toHaveTextContent("关系写入结果待核对");
    expect(canvas.getByRole("button", { name: "编辑任务" })).toBeDisabled();
    expect(canvas.getByRole("button", { name: "删除任务" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("button", { name: "刷新并核对任务列表" }));
    await userEvent.click(canvas.getByRole("button", { name: "确认当前关系，解除阻塞" }));
    expect(await canvas.findByRole("status", { name: "已确认当前关系状态，可以继续操作。" })).toHaveFocus();
  }
};

export const RelationshipReconciliationRecovery: Story = {
  args: { source: createStorySource(), mode: "create" },
  render: () => {
    const task: TaskRecord = { ...storyTasks[1], relationshipsConfirmed: false, reconciliationNotice: "关系写入结果待核对；请先刷新列表。" };
    const source = createStorySource({
      tasks: [storyTasks[0], task],
      getTask: (id) => id === task.id ? task : storyTasks.find((item) => item.id === id),
      isTaskReconciliationReady: (id) => id === task.id,
      acknowledgeTaskReconciliation: (id) => {
        if (id !== task.id) return false;
        task.relationshipsConfirmed = true;
        task.reconciliationNotice = undefined;
        return true;
      }
    });
    return <StoryFrame><TaskRelationshipEditor source={source} taskId={task.id} /></StoryFrame>;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "刷新并核对任务关系" }));
    await userEvent.click(canvas.getByRole("button", { name: "确认当前关系，解除阻塞" }));
    expect(await canvas.findByRole("status", { name: "已确认当前关系状态，可以继续操作。" })).toHaveFocus();
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
