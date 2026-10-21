import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { expect, userEvent, within } from "storybook/test";

import { createStorySource } from "@/features/tasks/story-source";

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

export const Edit: Story = { args: { source: createStorySource(), mode: "edit", projectId: "loomhelm" }, render: (args) => <StoryFrame><ProjectForm {...args} /></StoryFrame> };

export const ReadOnly: Story = { args: { source: createStorySource({ canWrite: false, isReadOnly: true }), mode: "create" }, render: (args) => <StoryFrame><ProjectForm {...args} /></StoryFrame> };

export const ProtectedDelete: Story = {
  args: { source: createStorySource(), mode: "create" },
  render: () => <StoryFrame><ProjectActions source={createStorySource({ deleteProject: async () => ({ ok: false, code: "blocked", message: "项目仍保留任务或对话，受保护删除已阻止。" }) })} projectId="loomhelm" /></StoryFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "删除项目" }));
    expect(await canvas.findByText("项目仍保留任务或对话，受保护删除已阻止。"));
  }
};
