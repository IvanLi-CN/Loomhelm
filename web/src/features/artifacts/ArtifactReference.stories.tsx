import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { useState, type ReactNode } from "react";

import type { Artifact } from "@loomhelm/protocol";

import { ArtifactReference } from "./ArtifactReference";
import type { ArtifactDownloadRequest } from "./api";

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
const pendingDownload = fn(() => new Promise<void>(() => undefined));
const pendingDownloadWithSignal = fn((_request: ArtifactDownloadRequest) => new Promise<void>(() => undefined));
const failingDownload = fn(async () => {
  throw new Error("download failed in story");
});

const loadArtifact = async () => artifact;
const loadNever = () => new Promise<Artifact>(() => undefined);
const loadUnauthorized = async () => {
  throw new Error("permission details stay outside the UI");
};

function Surface({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-[var(--canvas)] p-12" data-visual-evidence-surface><div className="mx-auto max-w-2xl" data-visual-evidence-target>{children}</div></div>;
}

function LoaderContextHarness() {
  const [loaderKey, setLoaderKey] = useState("principal-a");
  return <Surface><div className="grid gap-4"><button type="button" className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-[var(--line)] px-3 text-sm font-semibold text-[var(--ink)]" onClick={() => setLoaderKey("principal-b")}>切换授权上下文</button><ArtifactReference artifactId={artifact.id} loadMetadata={loadArtifact} loaderKey={loaderKey} download={pendingDownloadWithSignal} /></div></Surface>;
}

export const MetadataOnly: Story = {
  render: () => <Surface><ArtifactReference artifactId={artifact.id} loadMetadata={loadArtifact} /></Surface>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByRole("article", { name: "对话产物：reports/summary.md" })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "下载文件" })).toBeDisabled();
    expect(canvas.getByText("文件暂不可下载。")).toBeInTheDocument();
  }
};

export const Loading: Story = {
  render: () => <Surface><ArtifactReference artifactId={artifact.id} loadMetadata={loadNever} /></Surface>,
  play: ({ canvasElement }) => {
    expect(within(canvasElement).getByRole("status")).toHaveTextContent("正在读取授权产物…");
  }
};

export const ReadyToDownload: Story = {
  render: () => <Surface><ArtifactReference artifactId={artifact.id} loadMetadata={loadArtifact} download={downloadArtifact} /></Surface>,
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

export const PendingDownload: Story = {
  render: () => <Surface><ArtifactReference artifactId={artifact.id} loadMetadata={loadArtifact} download={pendingDownload} /></Surface>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "下载文件" }));
    expect(canvas.getByRole("button", { name: "准备下载…" })).toBeDisabled();
    expect(canvas.getByRole("status")).toHaveTextContent("正在准备下载…");
  }
};

export const DownloadFailure: Story = {
  render: () => <Surface><ArtifactReference artifactId={artifact.id} loadMetadata={loadArtifact} download={failingDownload} /></Surface>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "下载文件" }));
    expect(await canvas.findByText("下载失败，请重试。")).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "下载文件" })).toBeEnabled();
  }
};

export const LoaderContextChange: Story = {
  render: () => <LoaderContextHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const callCount = pendingDownloadWithSignal.mock.calls.length;
    await userEvent.click(await canvas.findByRole("button", { name: "下载文件" }));
    expect(canvas.getByRole("button", { name: "准备下载…" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("button", { name: "切换授权上下文" }));
    expect(await canvas.findByText("正在读取授权产物…")).toBeInTheDocument();
    await waitFor(() => expect(pendingDownloadWithSignal.mock.calls[callCount]?.[0]?.signal.aborted).toBe(true));
  }
};

export const Unauthorized: Story = {
  render: () => <Surface><ArtifactReference artifactId={artifact.id} loadMetadata={loadUnauthorized} /></Surface>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByRole("alert")).toBeInTheDocument();
    expect(canvas.getByText("授权产物暂时无法读取。请检查连接或权限后重试。")).toBeInTheDocument();
  }
};
