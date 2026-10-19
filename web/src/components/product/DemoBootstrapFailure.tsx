import { AlertTriangle, RefreshCcw } from "lucide-react";

import { Button } from "@/components/ui/button";

interface DemoBootstrapFailureProps {
  error: unknown;
}

export function DemoBootstrapFailure({ error }: DemoBootstrapFailureProps) {
  return (
    <main className="demo-failure" data-demo-bootstrap="failed">
      <div className="demo-failure-card">
        <span className="eyebrow">LOOMHELM DEMO</span>
        <div className="demo-failure-icon" aria-hidden="true">
          <AlertTriangle size={22} strokeWidth={1.8} />
        </div>
        <h1>演示启动已停止</h1>
        <p>Mock runtime 没有完成初始化，因此页面没有尝试认证、请求服务或执行任何真实命令。</p>
        <code>{error instanceof Error ? error.message : "Unknown demo bootstrap error"}</code>
        <Button type="button" variant="default" className="button button-primary" onClick={() => window.location.reload()}>
          <RefreshCcw size={16} aria-hidden="true" />
          重新启动 Demo
        </Button>
      </div>
    </main>
  );
}
