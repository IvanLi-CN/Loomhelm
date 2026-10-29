import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { ReactNode } from "react";

import type { Artifact } from "@loomhelm/protocol";

import { ArtifactReference } from "./ArtifactReference";

const artifact: Artifact = {
  id: "artifact-report-1",
  session_id: "session-demo-1",
  run_id: "run-demo-1",
  name: "reports/summary.md",
  kind: "file",
  size: 68,
  sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  content_type: "text/markdown",
  created_at: "2026-10-30T08:00:00Z"
};

const meta = {
  title: "Conversation/ArtifactReference",
  parameters: {
    layout: "fullscreen"
  },
  tags: ["autodocs"]
} satisfies Meta<typeof ArtifactReference>;

export default meta;

type Story = StoryObj<typeof meta>;

const downloadArtifact = fn();

function Surface({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-[var(--canvas)] p-12" data-visual-evidence-surface><div className="mx-auto max-w-2xl" data-visual-evidence-target>{children}</div></div>;
}

export const MetadataOnly: Story = {
  render: () => <Surface><ArtifactReference artifactId={artifact.id} loadMetadata={async () => artifact} /></Surface>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByRole("article", { name: "对话产物：reports/summary.md" })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "下载文件" })).toBeDisabled();
    expect(canvas.getByText("文件暂不可下载。")).toBeInTheDocument();
  }
};

export const Loading: Story = {
  render: () => <Surface><ArtifactReference artifactId={artifact.id} loadMetadata={() => new Promise<Artifact>(() => undefined)} /></Surface>,
  play: ({ canvasElement }) => {
    expect(within(canvasElement).getByRole("status")).toHaveTextContent("正在读取授权产物…");
  }
};

export const ReadyToDownload: Story = {
  render: () => <Surface><ArtifactReference artifactId={artifact.id} loadMetadata={async () => artifact} download={downloadArtifact} /></Surface>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = await canvas.findByRole("button", { name: "下载文件" });
    await userEvent.click(button);
    expect(await canvas.findByRole("button", { name: "已请求下载" })).toBeEnabled();
    expect(downloadArtifact).toHaveBeenCalledTimes(1);
    const request = downloadArtifact.mock.calls[0]?.[0];
    expect(request).toMatchObject({ artifact });
    expect(request.signal).toBeDefined();
  }
};

export const Unauthorized: Story = {
  render: () => <Surface><ArtifactReference artifactId={artifact.id} loadMetadata={async () => { throw new Error("permission details stay outside the UI"); }} /></Surface>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByRole("alert")).toBeInTheDocument();
    expect(canvas.getByText("授权产物暂时无法读取。请检查连接或权限后重试。")).toBeInTheDocument();
  }
};
