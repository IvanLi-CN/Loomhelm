import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

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
    <div className="min-h-screen bg-[var(--canvas)] p-10">
      <div className="min-h-[36rem]">
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
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const triggers = canvas.getAllByRole("combobox");
    expect(triggers).toHaveLength(5);
    for (const trigger of triggers) {
      expect(trigger).toHaveAttribute("data-size", "dense");
      expect(window.getComputedStyle(trigger).height).toBe("32px");
    }
    triggers[0].focus();
    expect(triggers[0]).toHaveFocus();
  }
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
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "收起 Demo 控制面板" }));
    expect(canvas.getByRole("button", { name: "打开 Demo 控制面板" })).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "收起为浮标" })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "打开 Demo 控制面板" }));
    expect(canvas.getByRole("button", { name: "收起 Demo 控制面板" })).toBeInTheDocument();
  }
};
