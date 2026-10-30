import { useMemo } from "react";

import { ProductionConversationWorkspace } from "@/features/conversations/ProductionConversationWorkspace";
import { createProductionSessionDemoApi } from "@/features/conversations/production-session-demo-api";
import { useOptionalDemoRuntime } from "@/demo/context";

export function DemoProductionConversationRoute() {
  const runtime = useOptionalDemoRuntime();
  const api = useMemo(() => createProductionSessionDemoApi(), []);
  if (!runtime) {
    return <section className="page-section unavailable-page" aria-label="Demo route unavailable"><span className="eyebrow">DEMO ONLY</span><h1>Demo 会话页不可用</h1><p>当前运行环境没有加载 mock runtime；生产路由不会启用 demo 数据。</p></section>;
  }
  const project = runtime.fixtures.projects.find((candidate) => candidate.id === "loomhelm");
  const task = runtime.fixtures.tasks.find((candidate) => candidate.id === "LH-30");

  return (
    <section className="page-section grid min-w-0 gap-6" data-demo-surface="u03-production-session" data-visual-evidence-surface="u03-production-session" data-visual-evidence-target="u03-production-session-page">
      <header className="page-heading mb-0">
        <div>
          <span className="eyebrow">U03 · SESSION / RUN / APPROVAL</span>
          <h1>生产会话工作区</h1>
          <p>这是登录前的 mock-only 证据页；内容来自与生产 renderer 相同的 Session、Run、事件和审批适配层。</p>
        </div>
        <span className="demo-write-chip">mock-only · 不调用服务端</span>
      </header>
      <ProductionConversationWorkspace
        api={api}
        conversationTitle={task?.title ?? "整理远程工作区边界"}
        initialRunId="run-demo-u03"
        principalId="demo-u03"
        projectId={project?.id}
        projectName={project?.name}
        projectOptions={runtime.fixtures.projects}
        sessionId="session-demo-u03"
        task={task}
      />
    </section>
  );
}
