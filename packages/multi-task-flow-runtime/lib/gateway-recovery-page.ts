import { createHash } from "node:crypto";
import {
  gatewayCopiedIcon,
  gatewayCopyIcon,
  gatewayUiCss,
  gatewayWarningIcon,
} from "./gateway-ui.generated";
import { dashboardHeaders } from "./server-contract";
import { json, runEntryPath } from "./service-http-helpers";
import type { WorkerDiagnostic } from "./worker-diagnostics";

export type GatewayRecovery = {
  diagnostic: WorkerDiagnostic;
  retry_after_ms: number;
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

// This script is deliberately self-contained: the Worker and all its assets may be unavailable.
export const gatewayRecoveryScript = `
(() => {
  const data = JSON.parse(document.getElementById("recovery-data").textContent);
  const retry = document.getElementById("retry");
  const status = document.getElementById("retry-status");
  const retryLabel = document.getElementById("retry-label");
  const countdown = document.getElementById("retry-countdown");
  const runId = document.getElementById("run-id");
  const identity = runId.closest(".run-identity");
  document.addEventListener("pointerdown", () => { identity.setAttribute("data-pointer-focus", ""); }, true);
  document.addEventListener("keydown", (event) => {
    if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) identity.removeAttribute("data-pointer-focus");
  }, true);
  let selectOnClick = false;
  runId.addEventListener("focus", () => { runId.select(); selectOnClick = true; });
  runId.addEventListener("pointermove", (event) => { if (event.buttons) selectOnClick = false; });
  runId.addEventListener("click", () => {
    if (selectOnClick) runId.select();
    selectOnClick = false;
  });
  runId.addEventListener("keydown", () => { selectOnClick = false; });
  const deadline = performance.now() + data.retry_after_ms;
  let connecting = false;
  function update() {
    if (connecting) return 0;
    const seconds = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    retry.disabled = seconds > 0;
    document.getElementById("retry-seconds").textContent = String(seconds);
    countdown.hidden = seconds === 0;
    status.textContent = seconds
      ? "服务正在等待重试窗口，请稍候。页面不会自动刷新。"
      : "可以重新尝试连接；如果仍未恢复，请复制诊断信息反馈。";
    return seconds;
  }
  const timer = setInterval(() => { if (!update()) clearInterval(timer); }, 250);
  update();
  retry.addEventListener("click", () => {
    if (performance.now() < deadline || retry.disabled) return;
    connecting = true;
    retry.disabled = true;
    retryLabel.textContent = "正在连接…";
    countdown.hidden = true;
    status.textContent = "正在重新打开当前编排页。";
    location.reload();
  });
  document.getElementById("copy-run").addEventListener("click", async () => {
    const button = document.getElementById("copy-run");
    const feedback = document.getElementById("run-copy-status");
    try {
      await navigator.clipboard.writeText(data.diagnostic.run_id);
      button.querySelector(".copy-icon").hidden = true;
      button.querySelector(".copied-icon").hidden = false;
      button.setAttribute("aria-label", "已复制编排 ID");
      feedback.textContent = "编排 ID 已复制";
    } catch {
      document.getElementById("diagnostics").open = true;
      const field = document.getElementById("copy-fallback");
      field.hidden = false;
      field.value = data.diagnostic.run_id;
      field.focus();
      field.select();
      document.getElementById("copy-status").textContent = "无法自动复制，请复制下方已选中的编排 ID。";
      feedback.textContent = "无法自动复制，已展开可手动复制的编排 ID。";
    }
  });
  document.getElementById("copy").addEventListener("click", async () => {
    const text = JSON.stringify(data, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      document.getElementById("copy-status").textContent = "诊断信息已复制";
    } catch {
      const field = document.getElementById("copy-fallback");
      field.hidden = false;
      field.value = text;
      field.focus();
      field.select();
      document.getElementById("copy-status").textContent = "无法自动复制，请复制下方已选中的诊断信息。";
    }
  });
})();`;

export function gatewayRecoveryPage(recovery: GatewayRecovery): string {
  const { diagnostic, retry_after_ms } = recovery;
  const seconds = Math.ceil(retry_after_ms / 1000);
  const details = [
    ["诊断编号", diagnostic.diagnostic_id],
    ["失败阶段", diagnostic.stage],
    ["错误码", diagnostic.error_code],
    ["Worker 构建", diagnostic.worker_key],
    ["Worker 代次", diagnostic.worker_generation],
    ["失败计数", String(diagnostic.retry_count)],
  ]
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value!)}</dd></div>`)
    .join("");
  const data = JSON.stringify(recovery).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-CN" data-theme="system"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>编排页暂时不可用 · Multi-task Flow</title>
<style>${gatewayUiCss}</style></head><body>
<header><a href="/" aria-label="Multi-task Flow · 编排列表">Multi-task Flow</a></header>
<main><article aria-labelledby="heading">
<div class="heading-row"><div class="signal" aria-hidden="true">${gatewayWarningIcon}</div><h1 id="heading">编排页暂时不可用</h1></div>
<p class="description">本地展示服务暂时无法连接此编排的页面进程。此错误不代表任务执行失败；恢复连接后可查看最新状态。</p>
<div class="run"><span>当前编排</span><div class="run-identity"><input id="run-id" class="input" aria-label="当前编排 ID" value="${escapeHtml(diagnostic.run_id)}" size="${Math.max(12, Math.min(48, diagnostic.run_id.length))}" readonly spellcheck="false"><button id="copy-run" type="button" class="btn btn-ghost btn-square" aria-label="复制编排 ID" title="复制编排 ID"><span class="copy-icon" aria-hidden="true">${gatewayCopyIcon}</span><span class="copied-icon" aria-hidden="true" hidden>${gatewayCopiedIcon}</span></button></div><span id="run-copy-status" class="sr-only" role="status"></span></div>
<div class="actions"><button type="button" id="retry" class="btn btn-primary"${seconds ? " disabled" : ""}><span id="retry-label">重试连接</span><span id="retry-countdown"${seconds ? "" : " hidden"}>（<span id="retry-seconds">${seconds}</span> 秒）</span></button><a class="home btn btn-outline" href="/">返回编排列表</a></div>
<p id="retry-status" role="status">${seconds ? "服务正在等待重试窗口，请稍候。页面不会自动刷新。" : "可以重新尝试连接；如果仍未恢复，请复制诊断信息反馈。"}</p>
<noscript><p>JavaScript 未启用。请${seconds ? `等待 ${seconds} 秒后` : ""}手动刷新当前页面以重试。</p></noscript>
<details id="diagnostics"><summary>技术详情与诊断信息</summary><dl>${details}</dl><button type="button" id="copy" class="btn btn-outline">复制诊断信息</button><p id="copy-status" role="status"></p><textarea id="copy-fallback" class="textarea" aria-label="诊断信息，可手动复制" readonly hidden></textarea></details>
</article><footer>重试只重新连接页面，不会重新派发任务或重复业务操作。</footer></main>
<script id="recovery-data" type="application/json">${data}</script><script>${gatewayRecoveryScript}</script>
</body></html>`;
}

export function workerFailureResponse(
  request: Request,
  diagnostic: WorkerDiagnostic,
  retryAfterMs: number,
): Response {
  const retry_after_ms = Math.max(0, Math.ceil(retryAfterMs));
  const retryHeaders = retry_after_ms
    ? { "Retry-After": String(Math.ceil(retry_after_ms / 1000)) }
    : {};
  if (
    request.method === "GET" &&
    runEntryPath.test(new URL(request.url).pathname) &&
    request.headers.get("accept")?.includes("text/html")
  ) {
    const hash = createHash("sha256").update(gatewayRecoveryScript).digest("base64");
    return new Response(gatewayRecoveryPage({ diagnostic, retry_after_ms }), {
      status: 503,
      headers: {
        ...dashboardHeaders,
        ...retryHeaders,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": dashboardHeaders["Content-Security-Policy"].replace(
          "script-src 'self'",
          `script-src 'sha256-${hash}'`,
        ),
      },
    });
  }
  return json({ code: "RUN_WORKER_UNAVAILABLE", ...diagnostic, retry_after_ms }, 503, retryHeaders);
}
