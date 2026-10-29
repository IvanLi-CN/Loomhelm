import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useState } from "react";

import { MobileNavigationBackdrop } from "./ProductShell";

const meta = {
  title: "Product/ProductShell",
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "mobile1" }
  },
  tags: ["autodocs"]
} satisfies Meta<typeof MobileNavigationBackdrop>;

export default meta;

type Story = StoryObj<typeof meta>;

function MobileNavigationHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen bg-[var(--canvas)] p-8" data-visual-evidence-surface>
      <div className="relative min-h-[32rem]" data-visual-evidence-target>
        <button type="button" className="button button-secondary" onClick={() => setOpen(true)} disabled={open}>打开导航</button>
        <p className="mt-4 text-sm text-[var(--muted)]">移动导航打开后，点击遮罩关闭。</p>
        {open && <MobileNavigationBackdrop onDismiss={() => setOpen(false)} />}
      </div>
    </div>
  );
}

export const MobileNavigation: Story = {
  render: () => <MobileNavigationHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "打开导航" }));
    expect(canvas.getByRole("button", { name: "关闭导航" })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "关闭导航" }));
    expect(canvas.getByRole("button", { name: "打开导航" })).toBeEnabled();
  }
};
