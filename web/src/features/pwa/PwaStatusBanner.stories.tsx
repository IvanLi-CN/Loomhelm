import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { ReactNode } from "react";

import { PwaStatusBanner } from "./PwaStatusBanner";
import { usePwaRuntime, type PwaRegister } from "./usePwaRuntime";

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

const applyUpdate = fn();

function RuntimeHarness({ register }: { register: PwaRegister }) {
  const runtime = usePwaRuntime(register);
  return <PwaStatusBanner placement="inline" isOnline={runtime.isOnline} updateAvailable={runtime.updateAvailable} updateApplied={runtime.updateApplied} updating={runtime.updating} registrationError={runtime.registrationError} onApplyUpdate={() => void runtime.applyUpdate()} />;
}

const runtimeRegister: PwaRegister = (options) => {
  options.onNeedRefresh?.();
  return async () => {
    options.onNeedReload?.();
  };
};

const failingRuntimeRegister: PwaRegister = (options) => {
  options.onNeedRefresh?.();
  return async () => {
    throw new Error("update failed in story");
  };
};

export const OfflineShell: Story = {
  render: () => <Surface><PwaStatusBanner placement="inline" isOnline={false} updateAvailable={false} updating={false} registrationError={false} onApplyUpdate={() => undefined} /></Surface>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("status")).toHaveTextContent("当前处于离线状态");
  }
};

export const UpdateAvailable: Story = {
  render: () => <Surface><PwaStatusBanner placement="inline" isOnline updateAvailable updating={false} registrationError={false} onApplyUpdate={applyUpdate} /></Surface>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "应用更新" }));
    expect(canvas.getByRole("button", { name: "应用更新" })).toBeInTheDocument();
    expect(applyUpdate).toHaveBeenCalledTimes(1);
  }
};

export const UpdateApplied: Story = {
  render: () => <Surface><PwaStatusBanner placement="inline" isOnline updateAvailable={false} updateApplied updating={false} registrationError={false} onApplyUpdate={fn()} /></Surface>,
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).getByRole("status")).toHaveTextContent("更新已准备");
  }
};

export const RuntimeUpdateFlow: Story = {
  render: () => <Surface><RuntimeHarness register={runtimeRegister} /></Surface>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "应用更新" }));
    expect(await canvas.findByRole("status")).toHaveTextContent("更新已准备");
    expect(canvas.queryByRole("button", { name: "应用更新" })).not.toBeInTheDocument();
  }
};

export const RuntimeUpdateFailure: Story = {
  render: () => <Surface><RuntimeHarness register={failingRuntimeRegister} /></Surface>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "应用更新" }));
    expect(await canvas.findByRole("status")).toHaveTextContent("离线更新服务暂不可用");
    expect(canvas.queryByRole("button", { name: "应用更新" })).not.toBeInTheDocument();
  }
};

export const RegistrationFailure: Story = {
  render: () => <Surface><PwaStatusBanner placement="inline" isOnline updateAvailable={true} updating={false} registrationError onApplyUpdate={fn()} /></Surface>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("status")).toHaveTextContent("离线更新服务暂不可用");
    expect(canvas.queryByRole("button", { name: "应用更新" })).not.toBeInTheDocument();
  }
};
