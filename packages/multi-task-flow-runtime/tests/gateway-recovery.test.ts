import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayRecoveryScript, workerFailureResponse } from "../lib/gateway-recovery-page";
import { ServiceAuth } from "../lib/service-auth";
import { startSharedViewer } from "../lib/service-http";
import type { WorkerDiagnostic } from "../lib/worker-diagnostics";
import {
  exportGatewayRecovery,
  gatewayDemoPages,
  gatewayDemoResponse,
} from "../scripts/export-gateway-recovery";
import { ViewerWorkerPool } from "../scripts/viewer-runtime";
import { fixtureRelease, fixtureRun, serviceFixture } from "./service-fixture";

export const diagnostic: WorkerDiagnostic = {
  diagnostic_id: "diag-6a65efb9-9ecd-404c-8af8-87f9c414ec17",
  run_id: "demo-recovery",
  worker_key: `schema-2/contract-3@${"e".repeat(64)}`,
  worker_generation: "unknown-generation",
  stage: "worker_select",
  error_code: "RUN_WORKER_UNAVAILABLE",
  safe_summary: "Viewer worker temporarily unavailable",
  retry_count: 3,
  state: "degraded",
  retryable: false,
  reconnect_required: true,
  first_seen_at: "2026-11-17T03:52:57.867Z",
  last_seen_at: "2026-11-17T03:53:14.536Z",
  recovered_at: null,
};

test("portable preview opens the actual recovery page by default", () => {
  const root = mkdtempSync(join(tmpdir(), "gateway-preview-entry-"));
  try {
    const exported = exportGatewayRecovery(join(root, "demo"), diagnostic);
    const entry = readFileSync(exported.entry, "utf8");
    expect(entry).toBe(readFileSync(join(exported.directory, "ready.html"), "utf8"));
    expect(entry).toContain('id="heading">编排页暂时不可用');
    expect(entry).toContain('id="run-id"');
    expect(entry).toContain('id="retry"');
    expect(entry).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pure Web demo serves the actual page on root and deep links, without exposing APIs or writes", async () => {
  const pages = gatewayDemoPages(diagnostic);
  for (const path of [
    "/",
    "/runs/demo-recovery/?demo=gateway-recovery&d_state=cooldown&d_theme=dark",
    "/cooldown.html",
    "/runs/demo-recovery/recovered.html",
  ]) {
    const response = gatewayDemoResponse(new Request(`http://localhost${path}`), pages);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain(
      path.includes("recovered") ? "连接已恢复" : 'id="heading">编排页暂时不可用',
    );
    if (!path.includes("recovered")) {
      expect(html).toContain('id="demo-controls"');
      expect(html).toContain('name="d_state"');
      expect(html).toContain('name="d_theme"');
      expect(html).toContain('name="d_run_id"');
      expect(html).toContain('name="d_wait_ms"');
    }
  }
  expect(gatewayDemoResponse(new Request("http://localhost/api/v1/runs"), pages).status).toBe(404);
  expect(
    gatewayDemoResponse(new Request("http://localhost/runs/demo-recovery/api/view"), pages).status,
  ).toBe(404);
  expect(
    gatewayDemoResponse(new Request("http://localhost/", { method: "POST" }), pages).status,
  ).toBe(405);
  expect(
    await gatewayDemoResponse(new Request("http://localhost/", { method: "HEAD" }), pages).text(),
  ).toBe("");
});

test("repeatable demo build preserves unrelated files and rejects output symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "gateway-demo-build-"));
  try {
    const output = join(root, "build");
    exportGatewayRecovery(output, diagnostic, true);
    writeFileSync(join(output, "keep.txt"), "keep");
    exportGatewayRecovery(output, diagnostic, true);
    expect(readFileSync(join(output, "keep.txt"), "utf8")).toBe("keep");
    expect(() => exportGatewayRecovery(output, diagnostic)).toThrow();
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "untouched");
    rmSync(join(output, "index.html"));
    symlinkSync(outside, join(output, "index.html"));
    expect(() => exportGatewayRecovery(output, diagnostic, true)).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("navigation gets a self-contained CSP-protected page while API and resource errors stay JSON", async () => {
  const url = "http://127.0.0.1/runs/demo-recovery/?plan=plan-a&tab=timeline";
  const page = workerFailureResponse(
    new Request(url, { headers: { accept: "text/html" } }),
    diagnostic,
    42_010,
  );
  expect(page.status).toBe(503);
  expect(page.headers.get("retry-after")).toBe("43");
  expect(page.headers.get("cache-control")).toBe("no-store");
  const body = await page.text();
  expect(body).toContain("编排页暂时不可用");
  expect(body).toContain("不代表任务执行失败");
  expect(body).toMatch(/id="retry"[^>]* disabled/);
  expect(body).toContain('id="retry-seconds">43</span>');
  expect(body).toContain('href="/"');
  expect(body).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=/);
  const hash = createHash("sha256").update(gatewayRecoveryScript).digest("base64");
  expect(page.headers.get("content-security-policy")).toContain(`script-src 'sha256-${hash}'`);
  expect(page.headers.get("content-security-policy")).not.toContain("script-src 'unsafe-inline'");
  for (const request of [
    new Request(url),
    new Request("http://127.0.0.1/runs/demo-recovery/api/view", {
      headers: { accept: "text/html" },
    }),
    new Request("http://127.0.0.1/runs/demo-recovery/assets/app.js", {
      headers: { accept: "*/*" },
    }),
    new Request(url, { method: "POST", headers: { accept: "text/html" } }),
  ]) {
    const response = workerFailureResponse(request, diagnostic, 42_010);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      code: "RUN_WORKER_UNAVAILABLE",
      diagnostic_id: diagnostic.diagnostic_id,
      retry_after_ms: 42_010,
    });
  }
});

test("page escapes diagnostic text and never embeds the request URL or ticket", async () => {
  const request = new Request("http://127.0.0.1/runs/demo-recovery/?ticket=PRIVATE&plan=plan-a", {
    headers: { accept: "text/html" },
  });
  const page = workerFailureResponse(
    request,
    { ...diagnostic, run_id: '</script><img src=x onerror="alert(1)">' },
    0,
  );
  const html = await page.text();
  expect(html).not.toContain("PRIVATE");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;/script&gt;");
  expect(html).toContain("\\u003c/script>");
  expect(html).toContain('id="retry-label">重试连接');
  expect(page.headers.get("retry-after")).toBeNull();
});

test("Gateway serves recovery HTML with Worker acquisition broken, preserves APIs, then serves the same target after recovery", async () => {
  const fixture = serviceFixture();
  const release = fixtureRelease(fixture.root);
  const { store } = fixtureRun(fixture.state.paths.data, "demo-recovery");
  store.update((run) => {
    run.resources = run.tasks
      .filter((task: { thread_id: string | null }) => task.thread_id)
      .map((task: { id: string; thread_id: string }) => ({
        id: `manual-${task.id}`,
        kind: "conversation" as const,
        target: task.thread_id!,
        status: "active" as const,
        evidence_ref: "fixture:manual-archive",
        archive_policy: "manual" as const,
      }));
  });
  const before = store.readRaw();
  let viewer: Awaited<ReturnType<typeof startSharedViewer>> | undefined;
  const acquire = spyOn(ViewerWorkerPool.prototype, "acquire").mockRejectedValue(
    new Error("synthetic worker failure"),
  );
  const count = spyOn(ViewerWorkerPool.prototype, "failureCount").mockReturnValue(3);
  const retry = spyOn(ViewerWorkerPool.prototype, "retryAfterMs").mockReturnValue(42_010);
  try {
    viewer = await startSharedViewer(
      fixture.state,
      release.manifest,
      join(release.source, "skills/multi-task-flow/dist"),
      0,
      undefined,
      undefined,
      () => () => {},
    );
    const base = `http://127.0.0.1:${viewer.port}`;
    const auth = new ServiceAuth(fixture.state);
    const cookie = auth.exchange(auth.ticket("/runs/demo-recovery/")).cookie.split(";")[0]!;
    const target = "/runs/demo-recovery/?plan=plan-a&tab=timeline";
    const headers = { cookie, accept: "text/html" };
    const page = await fetch(base + target, { headers });
    expect(page.status).toBe(503);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("retry-after")).toBe("43");
    expect(await page.text()).toContain("编排页暂时不可用");
    const api = await fetch(base + "/runs/demo-recovery/api/view", { headers });
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({
      code: "RUN_WORKER_UNAVAILABLE",
      retry_after_ms: 42_010,
    });
    expect((await fetch(base + "/", { headers })).status).toBe(200);
    expect((await fetch(base + "/api/v1/runs", { headers })).status).toBe(200);
    acquire.mockRestore();
    count.mockRestore();
    retry.mockRestore();
    const recovered = await fetch(base + target, { headers });
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toContain("<h1>Run</h1>");
    expect(store.readRaw()).toBe(before);
  } finally {
    acquire.mockRestore();
    count.mockRestore();
    retry.mockRestore();
    await viewer?.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
