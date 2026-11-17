import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gatewayRecoveryPage, gatewayRecoveryScript } from "../lib/gateway-recovery-page";
import { gatewayUiCss } from "../lib/gateway-ui.generated";
import type { WorkerDiagnostic } from "../lib/worker-diagnostics";

/** Portable, mock-only interaction demo; the production renderer and reconnect script stay intact. */
export function gatewayDemoPages(diagnostic: WorkerDiagnostic): Record<string, string> {
  const pages: Record<string, string> = {};
  const links =
    '<a href="./ready.html">可立即重试</a> · <a href="./cooldown.html">10 秒倒计时</a> · <a href="./recover.html?plan=example&tab=timeline#task-one">模拟恢复</a>';
  const inspector = `<details class="demo-controls"><summary>Demo 控制 · 仅模拟数据</summary><form id="demo-controls"><label>场景<select name="d_state"><option value="ready">可立即重试</option><option value="cooldown">等待重试</option><option value="recover">等待后恢复</option></select></label><label>主题<select name="d_theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><label>编排 ID<input name="d_run_id" maxlength="128"></label><label>等待毫秒<input name="d_wait_ms" type="number" min="0" max="60000" step="1000"></label><button class="btn btn-outline" type="submit">应用并重置</button><button class="btn btn-ghost" type="button" id="demo-share">复制场景链接</button><p id="demo-feedback" role="status"></p><input id="demo-share-fallback" aria-label="可手动复制的场景链接" readonly hidden></form></details>`;
  const inspectorStyle = `<style>.demo-controls{margin:0;padding:12px 24px;border-bottom:1px solid var(--viewer-border);border-top:0;background:var(--surface)}.demo-controls summary{font-size:13px;color:var(--muted)}.demo-controls form{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;max-width:1120px;margin:16px auto 4px}.demo-controls label{font-size:12px;display:grid;gap:4px}.demo-controls :is(input,select){min-width:0;border:1px solid var(--viewer-border);border-radius:var(--radius-control);background:var(--ground);color:var(--text);padding:8px;font:inherit}.demo-controls .btn{min-height:40px}.demo-controls p{font-size:12px;color:var(--muted)}@media(max-width:600px){.demo-controls form{grid-template-columns:1fr 1fr}}</style>`;
  const shell = (title: string, content: string) =>
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${gatewayUiCss} body{font:16px/1.8 system-ui;max-width:760px;padding:32px;margin:0 auto}a{color:inherit;text-underline-offset:4px}</style><script>const theme=new URL(location.href).searchParams.get("d_theme");document.documentElement.dataset.theme=["light","dark"].includes(theme)?theme:"system";</script><h1>${title}</h1>${content}</html>`;
  pages["recovered.html"] = shell(
    "连接已恢复",
    `<p>模拟恢复成功；当前 URL 保留原计划、标签页与定位。没有重新派发任务。</p><p>${links}</p>`,
  );
  for (const scenario of ["ready", "cooldown", "recover"] as const) {
    const wait = scenario === "ready" ? 0 : scenario === "cooldown" ? 10_000 : 3_000;
    // Keep the mock clock in the URL, so actual reloads retain the remaining window without storage.
    const bootstrap = `(() => {
      const url = new URL(location.href);
      const scene = ["ready", "cooldown", "recover"].includes(url.searchParams.get("d_state")) ? url.searchParams.get("d_state") : ${JSON.stringify(scenario)};
      const theme = ["light", "dark", "system"].includes(url.searchParams.get("d_theme")) ? url.searchParams.get("d_theme") : "system";
      document.documentElement.dataset.theme = theme;
      const rawWait = Number(url.searchParams.get("d_wait_ms"));
      const wait = url.searchParams.has("d_wait_ms") && Number.isFinite(rawWait) ? Math.min(60000, Math.max(0, rawWait)) : scene === "ready" ? 0 : scene === "recover" ? 3000 : 10000;
      const run = (url.searchParams.get("d_run_id") || "demo-recovery").slice(0, 128);
      const controls = document.getElementById("demo-controls");
      controls.elements.d_state.value = scene;
      controls.elements.d_theme.value = theme;
      controls.elements.d_wait_ms.value = String(wait);
      controls.elements.d_run_id.value = run;
      controls.action = location.pathname;
      controls.addEventListener("submit", (event) => {
        event.preventDefault();
        const target = new URL(location.href);
        for (const [key,value] of new FormData(controls)) target.searchParams.set(key, value);
        target.searchParams.delete("demo_started"); target.searchParams.set("demo", "gateway-recovery");
        location.assign(target.href);
      });
      document.getElementById("demo-share").addEventListener("click", async () => {
        const target = new URL(location.href); target.searchParams.delete("demo_started");
        try { await navigator.clipboard.writeText(target.href); document.getElementById("demo-feedback").textContent="场景链接已复制，打开后从头复现。"; }
        catch { const input=document.getElementById("demo-share-fallback");input.hidden=false;input.value=target.href;input.focus();input.select(); }
      });
      let started = Number(url.searchParams.get("demo_started"));
      if (!Number.isFinite(started) || started <= 0 || started > Date.now()) {
        started = Date.now(); url.searchParams.set("demo_started", String(started));
        history.replaceState(null, "", url.href);
      }
      const remaining = scene === "ready" ? 0 : Math.max(0, started + wait - Date.now());
      const node = document.getElementById("recovery-data");
      const data = JSON.parse(node.textContent); data.retry_after_ms = remaining;
      data.diagnostic.run_id = run;
      const runInput=document.getElementById("run-id");runInput.value=run;runInput.size=Math.max(12,Math.min(48,run.length));
      node.textContent = JSON.stringify(data);
      if (scene === "recover" && !remaining && performance.getEntriesByType("navigation")[0]?.type === "reload") {
        location.replace("./recovered.html" + location.search + location.hash);
      }
    })();`;
    const page = gatewayRecoveryPage({ diagnostic, retry_after_ms: wait })
      .replaceAll('href="/"', 'href="./index.html"')
      .replace("<body>", `<body>${inspectorStyle}${inspector}`)
      .replace(
        `<script>${gatewayRecoveryScript}`,
        `<script>${bootstrap}</script><script>${gatewayRecoveryScript}`,
      );
    pages[`${scenario}.html`] = page;
    if (scenario === "ready") pages["index.html"] = page;
  }
  return pages;
}

/** The HTTP host only serves these bundled pages; there is deliberately no API or Worker runtime. */
export function gatewayDemoResponse(request: Request, pages: Record<string, string>): Response {
  const pathname = new URL(request.url).pathname;
  const name =
    pathname === "/" || pathname === "/runs/demo-recovery/"
      ? "index.html"
      : pathname.replace(/^\/runs\/demo-recovery\//, "/").slice(1);
  const html = Object.hasOwn(pages, name) ? pages[name] : undefined;
  if (!["GET", "HEAD"].includes(request.method))
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  if (!html) return new Response("Not found", { status: 404 });
  return new Response(request.method === "HEAD" ? null : html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export function exportGatewayRecovery(
  directory: string,
  diagnostic: WorkerDiagnostic,
  rebuild = false,
) {
  // Repeatable builds overwrite only the five known generated files; never follow output symlinks.
  if (rebuild) {
    for (const ancestor of [resolve(directory), dirname(resolve(directory))]) {
      if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink())
        throw new Error("Demo output must not contain symbolic links");
    }
  }
  mkdirSync(directory, { mode: 0o700, recursive: rebuild });
  const pages = gatewayDemoPages(diagnostic);
  for (const name of Object.keys(pages)) {
    const file = join(directory, name);
    if (lstatSync(file, { throwIfNoEntry: false }) && !lstatSync(file).isFile())
      throw new Error("Demo output must contain regular files");
  }
  for (const [name, content] of Object.entries(pages))
    writeFileSync(join(directory, name), content);
  return {
    directory,
    entry: join(directory, "index.html"),
    scenarios: ["ready", "cooldown", "recover"],
  };
}
