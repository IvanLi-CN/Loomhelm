import type { GeneratedApiClient } from "@loomhelm/api-client";
import { useMemo } from "react";

import { AppProviders } from "@/app/providers";
import { useOptionalDemoRuntime } from "@/demo/context";
import { createCodexDemoApi } from "@/features/codex/demo-api";
import { ProductionConversationsRoute } from "@/routes/ProductionConversationsRoute";
import { createProductionSessionDemoApi } from "@/features/conversations/production-session-demo-api";
import { createProductionApiAssembly } from "@/lib/api/client";

export function DemoProductionConversationsRoute() {
  const runtime = useOptionalDemoRuntime();
  const apiAssembly = useMemo(() => createProductionApiAssembly({
    client: { ...createProductionSessionDemoApi(), ...createCodexDemoApi() } as GeneratedApiClient,
    auth: { status: "authenticated", principalId: "demo-conversations", workspaceId: "default", sessionGeneration: 1 },
    permissions: { canWrite: runtime?.canWrite ?? false, canManageProjects: runtime?.canManageProjects ?? false, isReadOnly: runtime?.isReadOnly ?? true }
  }), [runtime?.canManageProjects, runtime?.canWrite, runtime?.isReadOnly]);
  if (!runtime) return <section className="page-section unavailable-page"><span className="eyebrow">DEMO ONLY</span><h1>Session 列表演示不可用</h1><p>当前运行环境没有加载 mock runtime。</p></section>;
  return (
    <AppProviders apiAssembly={apiAssembly}>
      <div data-demo-surface="u05-production-sessions" data-visual-evidence-surface="u05-production-sessions" data-visual-evidence-target="u05-production-sessions-page">
        <ProductionConversationsRoute />
      </div>
    </AppProviders>
  );
}
