import type { Meta, StoryObj } from "@storybook/react-vite";

import { VerificationPanel } from "./VerificationPanel";

const meta = {
  title: "Technical/VerificationPanel",
  component: VerificationPanel,
  parameters: {
    layout: "fullscreen"
  },
  tags: ["autodocs"]
} satisfies Meta<typeof VerificationPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <div
      className="min-h-screen bg-slate-50 p-6 sm:p-10"
      data-visual-evidence-surface
    >
      <div className="mx-auto flex min-h-[32rem] max-w-3xl items-center" data-visual-evidence-target>
        <VerificationPanel {...args} />
      </div>
    </div>
  )
};

export const Compact: Story = {
  args: {
    compact: true
  },
  render: (args) => (
    <div
      className="min-h-screen bg-slate-50 p-6 sm:p-10"
      data-visual-evidence-surface
    >
      <div className="mx-auto flex min-h-[32rem] max-w-3xl items-center" data-visual-evidence-target>
        <VerificationPanel {...args} />
      </div>
    </div>
  )
};
