import type { ConnectObserver } from "./conversation-output";
import { Runtime } from "../../bin/modules/core/runtime";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createRunDashboard, dashboardHeaders } from "./server";
import { LedgerStore, readRegular, safeId } from "./store";
import { ServiceAuth } from "./service-auth";
import {
  compatibility,
  requireApi,
  requireLedgerCompatibility,
  type ReleaseManifest,
} from "./service-contract";
import { ContractError } from "./errors";
import { ServiceState } from "./service-state";
import {
  homePage,
  homeScript,
  loginPage,
  loginScript,
  viewerPage,
  runClientScript,
} from "./service-pages";
import { readBodyWithinLimit } from "./server-files";

const json = (
  value: unknown,
  status = 200,
  extra: Record<string, string> = {},
) =>
  Response.json(value, { status, headers: { ...dashboardHeaders, ...extra } });
const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      ...dashboardHeaders,
      "Content-Type": "text/html; charset=utf-8",
    },
  });
const script = (body: string) =>
  new Response(body, {
    headers: {
      ...dashboardHeaders,
      "Content-Type": "text/javascript; charset=utf-8",
    },
  });
const agentInput = z
  .object({
    thread_id: z.string().min(1),
    run_id: z.string().min(1),
    api_version: z.literal(1),
  })
  .strict();
export function agentLease(input: z.infer<typeof agentInput>) {
  safeId(input.thread_id);
  safeId(input.run_id);
  return {
    id: "agent:" + input.thread_id + ":" + input.run_id,
    kind: "agent" as const,
    thread_id: input.thread_id,
    run_id: input.run_id,
  };
}
async function body(request: Request): Promise<unknown> {
  const value = await readBodyWithinLimit(request, 8192);
  if (value === null)
    throw new ContractError("BODY_TOO_LARGE", "Request too large");
  return JSON.parse(value);
}
export function listRuns(root: string, offset = 0) {
  const runsPath = join(root, "runs");
  if (!existsSync(runsPath)) return { runs: [], total: 0 };
  const entries = readdirSync(runsPath, { withFileTypes: true })
    .filter(
      (item) =>
        item.isDirectory() &&
        /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(item.name),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    total: entries.length,
    runs: entries.slice(offset, offset + 100).map((item) => {
      try {
        const ledger = new LedgerStore(root, item.name).read();
        requireLedgerCompatibility(ledger);
        return {
          id: item.name,
          revision: ledger.revision,
          owner_thread_id: ledger.control.owner_thread_id,
          active_plan_id: ledger.active_plan_id,
        };
      } catch (error) {
        return {
          id: item.name,
          error:
            error instanceof ContractError ? error.code : "LEDGER_UNAVAILABLE",
        };
      }
    }),
  };
}

export function selectAssets(root: string, runId: string, shared: string) {
  const custom = join(root, "runs", safeId(runId), "view");
  if (!existsSync(custom)) return { path: shared, warning: null };
  try {
    if (!lstatSync(custom).isDirectory() || lstatSync(custom).isSymbolicLink())
      throw new Error();
    const manifest = z
      .object({ api_version: z.literal(1), frontend_contract: z.literal(1) })
      .strict()
      .parse(JSON.parse(readRegular(join(custom, "view.manifest.json"))));
    requireApi(manifest.api_version);
    return { path: custom, warning: null };
  } catch {
    return {
      path: shared,
      warning: "自定义视图未声明兼容合同或不兼容，已使用共享模板。",
    };
  }
}

export async function startSharedViewer(
  state: ServiceState,
  manifest: ReleaseManifest,
  assetsDir: string,
  port: number,
  sourceRevision?: () => string,
  sourceName?: string,
  demoHooks?: ConnectObserver | Pick<import("./server-contract").DashboardOptions, "connectObserver" | "archiveProvider" | "getProfileCapabilities">,
) {
  if ((sourceRevision || demoHooks) && !state.paths.isolated)
    throw new ContractError(
      "INVALID_PROFILE",
      "Source reload requires an isolated profile",
    );
  const auth = new ServiceAuth(state);
  const resources = new Map<string, ReturnType<typeof createRunDashboard>>();
  const warnings = new Map<string, string | null>();
  const getRun = (id: string) => {
    safeId(id);
    const existing = resources.get(id);
    if (existing) return existing;
    if (resources.size >= 64)
      for (const [key, resource] of resources)
        if (!resource.subscriberCount) {
          resource.stop();
          resources.delete(key);
          warnings.delete(key);
        }
    const ledger = new LedgerStore(state.paths.data, id).read();
    requireLedgerCompatibility(ledger);
    const assets = selectAssets(state.paths.data, id, assetsDir);
    warnings.set(id, assets.warning);
    const run = createRunDashboard({
      root: state.paths.data,
      runId: id,
      port,
      assetsDir: assets.path,
      ...(typeof demoHooks === "function" ? { connectObserver: demoHooks } : demoHooks),
    });
    resources.set(id, run);
    return run;
  };
  const server = await Runtime.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request, currentServer) {
      const host = `127.0.0.1:${currentServer.port}`;
      const origin = request.headers.get("origin");
      if (
        request.headers.get("host") !== host ||
        (origin && origin !== `http://${host}`)
      )
        return json({ code: "FORBIDDEN" }, 403);
      const url = new URL(request.url);
      try {
        if (request.method === "GET" && url.pathname === "/login")
          return html(loginPage);
        if (request.method === "GET" && url.pathname === "/login.js")
          return script(loginScript);
        if (request.method === "POST" && url.pathname === "/api/v1/login") {
          if (origin !== `http://${host}`)
            return json({ code: "FORBIDDEN" }, 403);
          const input = z
            .object({ ticket: z.string().max(100) })
            .strict()
            .parse(await body(request));
          const session = auth.exchange(input.ticket);
          return json({ target: session.target }, 200, {
            "Set-Cookie": session.cookie,
          });
        }
        const actor = auth.authorize(request);
        if (!actor)
          return request.method === "GET" && !url.pathname.startsWith("/api/")
            ? html(
                viewerPage(
                  "需要连接本地展示服务",
                  "<p>请通过 service login 获取一次性登录入口，再打开此运行链接。</p>",
                ),
                401,
              )
            : json({ code: "UNAUTHENTICATED" }, 401);
        if (
          request.method !== "GET" &&
          actor.kind === "browser" &&
          origin !== `http://${host}`
        )
          return json({ code: "FORBIDDEN" }, 403);
        if (
          sourceRevision &&
          request.method === "GET" &&
          url.pathname === "/api/v1/source"
        )
          return json({ revision: sourceRevision(), name: sourceName });
        if (
          sourceRevision &&
          request.method === "GET" &&
          url.pathname === "/source-client.js"
        )
          return script(
            `document.title=${JSON.stringify(sourceName ?? "源码开发预览")};let previous=${JSON.stringify(sourceRevision())};setInterval(async()=>{try{const response=await fetch('/api/v1/source');if(!response.ok)return;const value=await response.json();if(previous&&previous!==value.revision)location.reload();previous=value.revision}catch{}},1000);`,
          );
        if (url.pathname === "/api/v1/status" && request.method === "GET") {
          if (actor.kind !== "cli") return json({ code: "FORBIDDEN" }, 403);
          return json({
            ok: true,
            build_id: manifest.build_id,
            source_sha: manifest.source_sha,
            compatibility,
            generation: state.runtime().generation,
            pid: process.pid,
            port: currentServer.port,
          });
        }
        if (url.pathname === "/api/v1/lease" && request.method === "POST") {
          if (actor.kind === "browser")
            return json(state.renewBrowser(actor.id));
          const input = agentInput.parse(await body(request));
          requireApi(input.api_version);
          return json(
            state.renew(agentLease(input), state.config().agent_ttl_ms),
          );
        }
        if (url.pathname === "/api/v1/runs" && request.method === "GET") {
          const offset = Number(url.searchParams.get("offset") ?? 0);
          if (!Number.isInteger(offset) || offset < 0)
            return json({ code: "INVALID_OFFSET" }, 400);
          return json({
            ...listRuns(state.paths.data, offset),
            build_id: manifest.build_id,
          });
        }
        if (request.method === "GET" && url.pathname === "/")
          return html(homePage);
        if (request.method === "GET" && url.pathname === "/home.js")
          return script(homeScript);
        if (request.method === "GET" && url.pathname === "/service-client.js")
          return script(runClientScript);
        const match = url.pathname.match(
          /^\/(?:api\/v1\/)?runs\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/(.*)$/,
        );
        if (!match) return json({ code: "NOT_FOUND" }, 404);
        const id = match[1]!;
        const run = getRun(id);
        let path = "/" + match[2]!;
        if (url.pathname.startsWith("/api/v1/")) path = "/api/" + match[2]!;
        if (path === "/api/service" && request.method === "GET")
          return json({
            build_id: manifest.build_id,
            warning: warnings.get(id),
          });
        if (
          path === "/api/lease" &&
          request.method === "POST" &&
          actor.kind === "browser"
        )
          return json(state.renewBrowser(actor.id));
        const response = await run.handle(request, currentServer, path);
        if (
          path === "/" &&
          response.ok &&
          response.headers.get("content-type")?.startsWith("text/html")
        ) {
          return html(
            (await response.text()) +
              '<script src="/service-client.js" defer></script>' +
              (sourceRevision
                ? '<script src="/source-client.js" defer></script>'
                : ""),
          );
        }
        return response;
      } catch (error) {
        const code =
          error instanceof ContractError
            ? error.code
            : error instanceof z.ZodError || error instanceof SyntaxError
              ? "INVALID_INPUT"
              : "SERVICE_ERROR";
        const status =
          code === "INVALID_TICKET"
            ? 401
            : code === "SERVICE_STOPPING"
              ? 409
              : code === "INVALID_INPUT"
                ? 400
                : 503;
        return json({ code }, status);
      }
    },
  });
  return {
    port: server.port!,
    get watcherCount() {
      return [...resources.values()].filter((run) => run.subscriberCount > 0)
        .length;
    },
    async stop() {
      for (const run of resources.values()) run.stop();
      resources.clear();
      warnings.clear();
      await server.stop(true);
    },
  };
}
