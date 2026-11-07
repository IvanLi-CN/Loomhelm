import type { GeneratedApiClient } from "@loomhelm/api-client";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { AppProviders } from "@/app/providers";
import { createCodexDemoApi } from "@/features/codex/demo-api";
import { createProductionSessionDemoApi } from "@/features/conversations/production-session-demo-api";
import { codexRouteKey } from "@/features/codex/source";
import { createProductionApiAssembly } from "@/lib/api/client";

import { ProductionConversationsRoute } from "./ProductionConversationsRoute";

type ConversationIndexState = "both" | "sessions-empty" | "sessions-error" | "codex-empty" | "codex-error" | "sessions-loading" | "codex-loading";

const codexSnapshot = {
  as_of: "2026-11-07T00:00:00Z",
  has_more: false,
  items: [],
  snapshot_state: "complete" as const
};

function createStoryClient(state: ConversationIndexState): GeneratedApiClient {
  const client = { ...createProductionSessionDemoApi(), ...createCodexDemoApi() } as GeneratedApiClient;
  if (state === "sessions-empty") client.listSessions = async () => ({ has_more: false, items: [] });
  if (state === "sessions-error") client.listSessions = async () => { throw new Error("Session 列表读取失败"); };
  if (state === "codex-empty") client.listCodexConversations = async () => codexSnapshot;
  if (state === "codex-error") client.listCodexSources = async () => { throw new Error("Codex 来源读取失败"); };
  if (state === "sessions-loading") client.listSessions = () => new Promise(() => {});
  if (state === "codex-loading") client.listCodexSources = () => new Promise(() => {});
  return client;
}

function StorySurface({ state, detailReturnTo }: { state: ConversationIndexState; detailReturnTo?: "demo-production-conversations" }) {
  const apiAssembly = createProductionApiAssembly({
    client: createStoryClient(state),
    auth: { status: "authenticated", principalId: `story-conversations-${state}`, workspaceId: "default", sessionGeneration: 1 },
    permissions: { canWrite: true, canManageProjects: true, isReadOnly: false }
  });
  return (
    <AppProviders apiAssembly={apiAssembly}>
      <div className="min-h-screen bg-[var(--canvas)] p-8">
        <ProductionConversationsRoute detailReturnTo={detailReturnTo} />
      </div>
    </AppProviders>
  );
}

const meta = {
  title: "Routes/Production Conversations",
  component: ProductionConversationsRoute,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"]
} satisfies Meta<typeof ProductionConversationsRoute>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BothSources: Story = {
  render: () => <StorySurface state="both" detailReturnTo="demo-production-conversations" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText("Session session-demo-u03")).toBeInTheDocument();
    const codexLink = await canvas.findByRole("link", { name: /未绑定材料/ });
    expect(codexLink).toHaveAttribute("href", `/conversations/${encodeURIComponent(codexRouteKey("host-default", "thread-2"))}?returnTo=demo-production-conversations`);
    expect(canvas.getByText("材料未完整")).toBeInTheDocument();
  }
};

export const SessionsEmptyCodexAvailable: Story = {
  render: () => <StorySurface state="sessions-empty" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText("还没有可访问的对话")).toBeInTheDocument();
    expect(await canvas.findByText("未绑定材料")).toBeInTheDocument();
  }
};

export const CodexEmptySessionAvailable: Story = {
  render: () => <StorySurface state="codex-empty" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText("Session session-demo-u03")).toBeInTheDocument();
    expect(await canvas.findByText("当前没有可见的 Codex 对话")).toBeInTheDocument();
  }
};

export const CodexErrorSessionAvailable: Story = {
  render: () => <StorySurface state="codex-error" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText("Session session-demo-u03")).toBeInTheDocument();
    expect(await canvas.findByText("Codex 来源暂时不可用")).toBeInTheDocument();
  }
};

export const SessionsErrorCodexAvailable: Story = {
  render: () => <StorySurface state="sessions-error" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText("暂时无法读取对话")).toBeInTheDocument();
    expect(await canvas.findByText("Codex 对话")).toBeInTheDocument();
  }
};

export const SessionsLoadingCodexAvailable: Story = {
  render: () => <StorySurface state="sessions-loading" />
};

export const CodexLoadingSessionAvailable: Story = {
  render: () => <StorySurface state="codex-loading" />
};
