import type { Meta, StoryObj } from "@storybook/react-vite";
import type { GeneratedApiClient } from "@loomhelm/api-client";

import { AppProviders } from "@/app/providers";

import { CodexConversationsRoute, type CodexConversationsRouteProps } from "./CodexConversations";
import { createCodexDemoApi } from "./demo-api";

const client = createCodexDemoApi();

const meta = {
  title: "Features/Codex Conversations",
  component: CodexConversationsRoute,
  args: {},
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <AppProviders apiAssembly={{ client, auth: { status: "authenticated", principalId: "story-user", workspaceId: "default", sessionGeneration: 1 }, permissions: { canWrite: true, canManageProjects: true, isReadOnly: false } }}><div className="min-h-screen bg-[var(--canvas)] p-8" data-visual-evidence-surface><div data-visual-evidence-target><Story /></div></div></AppProviders>]
} satisfies Meta<typeof CodexConversationsRoute>;

export default meta;
type Story = StoryObj<CodexConversationsRouteProps>;

export const CompleteAndReadOnly: Story = {};
