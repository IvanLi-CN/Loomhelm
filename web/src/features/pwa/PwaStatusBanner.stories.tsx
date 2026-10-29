import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import type { ReactNode } from "react";

import { PwaStatusBanner } from "./PwaStatusBanner";

const meta = {
  title: "PWA/PwaStatusBanner",
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: {
        loomhelmMobile: {
          name: "Loomhelm mobile 393x852",
          styles: { width: "393px", height: "852px" },
          type: "mobile"
        }
      }
    }
  },
  globals: { viewport: "loomhelmMobile" },
  tags: ["autodocs"]
} satisfies Meta<typeof PwaStatusBanner>;

export default meta;

type Story = StoryObj<typeof meta>;

function Surface({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-end bg-[var(--canvas)] p-8" data-visual-evidence-surface><div className="relative w-full" data-visual-evidence-target>{children}</div></div>;
}

export const OfflineShell: Story = {
  render: () => <Surface><PwaStatusBanner placement="inline" isOnline={false} updateAvailable={false} updating={false} registrationError={false} onApplyUpdate={() => undefined} /></Surface>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("status")).toHaveTextContent("当前处于离线状态");
  }
};

export const UpdateAvailable: Story = {
  render: () => <Surface><PwaStatusBanner placement="inline" isOnline updateAvailable updating={false} registrationError={false} onApplyUpdate={() => undefined} /></Surface>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "应用更新" }));
    expect(canvas.getByRole("button", { name: "应用更新" })).toBeInTheDocument();
  }
};

export const RegistrationFailure: Story = {
  render: () => <Surface><PwaStatusBanner placement="inline" isOnline updateAvailable={false} updating={false} registrationError onApplyUpdate={() => undefined} /></Surface>
};
