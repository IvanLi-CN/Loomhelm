import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { expect, fn, userEvent, within } from "storybook/test";

import { createStorySource, storyProjects } from "@/features/tasks/story-source";
import type { ProjectRecord } from "@/features/tasks/types";

import { ProjectActions, ProjectForm } from "./ProjectForm";

const meta = {
  title: "Product/ProjectForm",
  component: ProjectForm,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"]
} satisfies Meta<typeof ProjectForm>;

export default meta;

type Story = StoryObj<typeof meta>;

function StoryFrame({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-[var(--canvas)] p-8" data-visual-evidence-surface><div className="mx-auto max-w-2xl" data-visual-evidence-target>{children}</div></div>;
}

function pendingCreationSource() {
  const source = createStorySource();
  const noticeId = "project:create:story";
  source.pendingProjectCreation = true;
  source.pendingProjectCreationNoticeId = noticeId;
  source.isPendingProjectCreationReady = (id) => id === noticeId;
  source.acknowledgePendingProjectCreation = (id) => {
    if (id !== noticeId) return false;
    source.pendingProjectCreation = false;
    delete source.pendingProjectCreationNoticeId;
    return true;
  };
  return source;
}

function knownCreationSource() {
  const source = createStorySource();
  const projectId = "project_0123456789abcdef0123456789abcdef";
  source.pendingProjectCreation = true;
  source.pendingProjectCreationResourceId = projectId;
  source.isProjectReconciliationReady = (id) => id === projectId;
  source.acknowledgeProjectReconciliation = (id) => {
    if (id !== projectId) return false;
    source.pendingProjectCreation = false;
    delete source.pendingProjectCreationResourceId;
    return true;
  };
  return source;
}

function incompleteKnownCreationSource() {
  const source = knownCreationSource();
  source.isProjectReconciliationReady = () => false;
  return source;
}

function reconciliationSource() {
  const project: ProjectRecord = { ...storyProjects[0], reconciliationNotice: "项目写入结果待确认；请刷新后核对。" };
  const source = createStorySource({
    projects: [project, ...storyProjects.slice(1)],
    getProject: (id) => id === project.id ? project : storyProjects.find((item) => item.id === id),
    isProjectReconciliationReady: (id) => id === project.id,
    acknowledgeProjectReconciliation: (id) => {
      if (id !== project.id) return false;
      project.reconciliationNotice = undefined;
      return true;
    }
  });
  return source;
}

function actionReconciliationSource() {
  const project: ProjectRecord = { ...storyProjects[0], reconciliationNotice: "项目写入结果待确认；请刷新后核对。" };
  return createStorySource({
    projects: [project, ...storyProjects.slice(1)],
    getProject: (id) => id === project.id ? project : storyProjects.find((item) => item.id === id),
    isProjectReconciliationReady: (id) => id === project.id,
    acknowledgeProjectReconciliation: (id) => {
      if (id !== project.id) return false;
      project.reconciliationNotice = undefined;
      return true;
    }
  });
}

export const Create: Story = {
  args: { source: createStorySource(), mode: "create" },
  render: (args) => <StoryFrame><ProjectForm {...args} /></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const name = canvas.getByLabelText("项目名称");
    await userEvent.type(name, "新项目");
    expect(name).toHaveValue("新项目");
  }
};

export const PendingCreationRecovery: Story = {
  args: { source: pendingCreationSource(), mode: "create" },
  render: (args) => <StoryFrame><ProjectForm {...args} /></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText("上一次项目创建结果仍待确认；请先检查项目列表，当前表单不会再次提交。")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "刷新并核对项目列表" }));
    expect(await canvas.findByText("列表已刷新，但本次项目创建结果仍待确认；为避免重复创建，当前表单不会再次提交。")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "确认未创建，允许重新提交" }));
    expect(await canvas.findByText("已确认项目列表中没有这次写入，可以重新提交。")).toBeInTheDocument();
    expect(canvas.getByRole("form", { name: "创建项目" })).toHaveFocus();
  }
};

export const KnownCreationRecovery: Story = {
  args: { source: knownCreationSource(), mode: "create", onSaved: fn() },
  render: (args) => <StoryFrame><ProjectForm {...args} /></StoryFrame>,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "刷新并核对项目列表" }));
    expect(await canvas.findByText("已刷新并核对预选项目，可以确认当前状态后解除阻塞。")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "确认当前项目状态，解除阻塞" }));
    expect(await canvas.findByText("已确认当前项目状态，可以继续操作。")).toBeInTheDocument();
    expect(args.onSaved).toHaveBeenCalledWith("project_0123456789abcdef0123456789abcdef");
    expect(canvas.getByRole("form", { name: "创建项目" })).toHaveFocus();
  }
};

export const KnownCreationIncompleteRefresh: Story = {
  args: { source: incompleteKnownCreationSource(), mode: "create" },
  render: (args) => <StoryFrame><ProjectForm {...args} /></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "刷新并核对项目列表" }));
    expect(await canvas.findByText("列表已刷新，但预选项目写入仍在进行或尚未完成确认；请稍后再次刷新。")).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "确认当前项目状态，解除阻塞" })).not.toBeInTheDocument();
  }
};

export const KnownCreationRefreshFailure: Story = {
  args: { source: createStorySource({ ...knownCreationSource(), refresh: async () => { throw new Error("模拟刷新失败"); } }), mode: "create" },
  render: (args) => <StoryFrame><ProjectForm {...args} /></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "刷新并核对项目列表" }));
    expect(await canvas.findByText("刷新项目列表失败：模拟刷新失败")).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "确认当前项目状态，解除阻塞" })).not.toBeInTheDocument();
  }
};

export const ReconciliationRecovery: Story = {
  args: { source: reconciliationSource(), mode: "edit", projectId: "loomhelm" },
  render: (args) => <StoryFrame><ProjectForm {...args} /></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "刷新并核对项目列表" }));
    expect(await canvas.findByText("已刷新并核对项目列表，可以确认当前状态后解除阻塞。")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "确认当前项目状态，解除阻塞" }));
    expect(await canvas.findByText("已确认当前项目状态，可以继续操作。")).toBeInTheDocument();
    expect(canvas.getByRole("form", { name: "编辑项目" })).toHaveFocus();
  }
};

export const ActionReconciliationRecovery: Story = {
  args: { source: actionReconciliationSource(), mode: "create" },
  render: (args) => <StoryFrame><ProjectActions source={args.source} projectId="loomhelm" /></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "刷新并核对项目列表" }));
    await userEvent.click(canvas.getByRole("button", { name: "确认当前项目状态，解除阻塞" }));
    expect(await canvas.findByRole("status", { name: "已确认当前项目状态，可以继续操作。" })).toHaveFocus();
  }
};

export const Edit: Story = { args: { source: createStorySource(), mode: "edit", projectId: "loomhelm" }, render: (args) => <StoryFrame><ProjectForm {...args} /></StoryFrame> };

export const ReadOnly: Story = { args: { source: createStorySource({ canCreateProjects: false, getProjectPermissions: () => ({ role: "viewer", canWrite: false, canManageProjects: false, isReadOnly: true }) }), mode: "create" }, render: (args) => <StoryFrame><ProjectForm {...args} /></StoryFrame> };

export const OperatorProjectAccess: Story = {
  args: { source: createStorySource({ canCreateProjects: false }), mode: "create" },
  render: (args) => <StoryFrame><ProjectForm {...args} /></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("button", { name: "保存项目" })).toBeDisabled();
    expect(await canvas.findByText("当前身份或连接状态不能创建项目。")).toBeInTheDocument();
  }
};

export const ProtectedDelete: Story = {
  args: { source: createStorySource(), mode: "create" },
  render: () => <StoryFrame><ProjectActions source={createStorySource({ deleteProject: async () => ({ ok: false, code: "blocked", message: "项目仍保留任务或对话，受保护删除已阻止。" }) })} projectId="loomhelm" /></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "删除项目" }));
    expect(await canvas.findByText("项目仍保留任务或对话，受保护删除已阻止。"));
  }
};
