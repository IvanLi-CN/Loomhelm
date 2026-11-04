import { useMemo } from "react";

import { AppProviders } from "@/app/providers";
import { useOptionalDemoRuntime } from "@/demo/context";
import { createProductionApiAssembly } from "@/lib/api/client";

import { createCodexDemoApi } from "@/features/codex/demo-api";
import { CodexConversationsRoute } from "@/features/codex/CodexConversations";

export function DemoCodexConversationsRoute() {
  const runtime = useOptionalDemoRuntime();
  const apiAssembly = useMemo(() => createProductionApiAssembly({
    client: createCodexDemoApi(),
    auth: { status: "authenticated", principalId: "demo-codex", workspaceId: "default", sessionGeneration: 1 },
    permissions: { canWrite: runtime?.canWrite ?? false, canManageProjects: runtime?.canManageProjects ?? false, isReadOnly: runtime?.isReadOnly ?? true }
  }), [runtime?.canManageProjects, runtime?.canWrite, runtime?.isReadOnly]);

  if (!runtime) return <section className="page-section unavailable-page"><span className="eyebrow">DEMO ONLY</span><h1>Codex 对话演示不可用</h1><p>当前运行环境没有加载 mock runtime。</p></section>;

  return (
    <AppProviders apiAssembly={apiAssembly}>
      <div data-demo-surface="u04-codex-source" data-visual-evidence-surface="u04-codex-source">
        <CodexConversationsRoute />
      </div>
    </AppProviders>
  );
}
