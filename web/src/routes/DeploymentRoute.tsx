import { Link } from "@tanstack/react-router";

import { useOptionalProductionApi } from "@/app/providers";
import { Button } from "@/components/ui/button";
import { DeploymentConsole } from "@/features/deployment/DeploymentConsole";

export function DeploymentRoute() {
  const assembly = useOptionalProductionApi();
  if (assembly?.auth.status !== "authenticated" || !assembly.auth.principalId) {
    return <section className="page-section unavailable-page"><span className="eyebrow">INSTALLATION CONTROL</span><h1>部署控制不可用</h1><p>需要有效的浏览器会话才能读取安装级部署状态。</p><Button asChild variant="secondary" className="button button-secondary"><Link to="/">返回工作台</Link></Button></section>;
  }
  return <DeploymentConsole client={assembly.client} principalId={assembly.auth.principalId} />;
}
