import { useMemo } from "react";

import { useOptionalDemoRuntime } from "@/demo/context";
import { ProductionConversationsRoute } from "@/routes/ProductionConversationsRoute";
import { createProductionSessionDemoApi } from "@/features/conversations/production-session-demo-api";

export function DemoProductionConversationsRoute() {
  const runtime = useOptionalDemoRuntime();
  const api = useMemo(() => createProductionSessionDemoApi(), []);
  if (!runtime) return <section className="page-section unavailable-page"><span className="eyebrow">DEMO ONLY</span><h1>Session 列表演示不可用</h1><p>当前运行环境没有加载 mock runtime。</p></section>;
  return (
    <div data-demo-surface="u05-production-sessions" data-visual-evidence-surface="u05-production-sessions" data-visual-evidence-target="u05-production-sessions-page">
      <ProductionConversationsRoute api={api} principalId="demo-sessions" sessionGeneration={1} />
    </div>
  );
}
