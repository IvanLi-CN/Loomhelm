import type { Meta, StoryObj } from "@storybook/react-vite";

import { DemoInspector } from "./DemoInspector";
import { DemoProvider } from "@/demo/context";
import { createFixturesForState } from "@/demo/fixtures";
import type { DemoBootstrapSnapshot } from "@/demo/types";

const runtime: DemoBootstrapSnapshot = {
  scene: "normal",
  persona: "owner",
  network: "online",
  dataMode: "full",
  theme: "light",
  taskViews: {},
  drafts: {},
  fixtures: createFixturesForState("owner", "full", false)
};

const meta = {
  title: "Demo/DemoInspector",
  component: DemoInspector,
  parameters: {
    layout: "fullscreen"
  },
  tags: ["autodocs"]
} satisfies Meta<typeof DemoInspector>;

export default meta;

type Story = StoryObj<typeof meta>;

function StoryFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-100 p-6" data-visual-evidence-surface>
      <div className="min-h-[36rem] rounded-xl border border-slate-200 bg-white/70 p-8" data-visual-evidence-target>
        <p className="text-sm text-slate-500">Demo controls are intentionally local to this surface.</p>
        {children}
      </div>
    </div>
  );
}

export const Default: Story = {
  render: () => (
    <DemoProvider runtime={runtime}>
      <StoryFrame><DemoInspector /></StoryFrame>
    </DemoProvider>
  )
};

export const Offline: Story = {
  render: () => (
    <DemoProvider runtime={{ ...runtime, scene: "offline", network: "offline" }}>
      <StoryFrame><DemoInspector /></StoryFrame>
    </DemoProvider>
  )
};

export const Collapsed: Story = {
  render: () => (
    <DemoProvider runtime={runtime}>
      <StoryFrame><DemoInspector /></StoryFrame>
    </DemoProvider>
  ),
  play: async ({ canvasElement }) => {
    const button = canvasElement.querySelector<HTMLButtonElement>("[aria-label='收起 Demo 控制面板']");
    button?.click();
  }
};
