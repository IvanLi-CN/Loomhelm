import type { Meta, StoryObj } from "@storybook/react-vite";

import { TaskStateBadge } from "./TaskViews";
import { taskStates, type TaskState } from "@/demo/types";

const meta = {
  title: "Product/TaskStateBadge",
  component: TaskStateBadge,
  parameters: {
    layout: "fullscreen"
  },
  tags: ["autodocs"]
} satisfies Meta<typeof TaskStateBadge>;

export default meta;

type Story = StoryObj<typeof meta>;

function BadgeGallery({ states }: { states: readonly TaskState[] }) {
  return (
    <div className="min-h-screen bg-slate-100 p-8" data-visual-evidence-surface>
      <div className="mx-auto grid max-w-2xl gap-4 rounded-xl border border-slate-200 bg-white p-8" data-visual-evidence-target>
        <div><span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Task business state</span><h1 className="mt-2 text-xl font-semibold text-slate-900">任务状态组件</h1></div>
        <div className="flex flex-wrap gap-3">{states.map((state) => <TaskStateBadge key={state} state={state} />)}</div>
      </div>
    </div>
  );
}

export const StateGallery: Story = {
  args: { state: "待办" },
  render: () => <BadgeGallery states={taskStates} />
};

export const Blocked: Story = {
  args: { state: "阻塞" },
  render: (args) => <BadgeGallery states={[args.state]} />
};
