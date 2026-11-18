import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Runtime } from "@loomhelm/runtime-core/modules/core/runtime";
import { z } from "zod";
import type { ConnectObserver } from "../lib/conversation-output";
import { ContractError } from "../lib/errors";
import { workerFailureResponse } from "../lib/gateway-recovery-page";
import {
  type RuntimeMetadata,
  runtimeMetadata,
  runtimeMetadataFromViewer,
  type StaticViewerProvenance,
  staticViewerProvenanceSchema,
  unknownStaticViewerProvenance,
} from "../lib/runtime-metadata";
import { createRunDashboard, dashboardHeaders } from "../lib/server";
import { ServiceAuth } from "../lib/service-auth";
import {
  compatibility,
  type ReleaseManifest,
  requireApi,
  requireLedgerCompatibility,
} from "../lib/service-contract";
import {
  authFailedPage,
  homePage,
  homeScript,
  parseViewerTarget,
  runClientScript,
  viewerPage,
} from "../lib/service-pages";
import { verifyRelease } from "../lib/service-release";
import type { ServiceState } from "../lib/service-state";
import { LedgerStore, readRegular, safeId } from "../lib/store";
import { parseViewerRoute } from "../scripts/viewer-gateway";
import { createWorkerGeneration, ViewerWorkerPool } from "../scripts/viewer-runtime";
import { startUnixViewerWorkerServer, viewerWorkerSocketPath } from "../scripts/viewer-socket";
import { createUnixViewerWorker, dataVersionOf, workerKeyOf } from "../scripts/viewer-worker";
import { CONTRACT_VERSION } from "./contract";
import { identityOf, requireRunIdentity } from "./orchestration-identity";
import {
  agentInput,
  agentLease,
  authFailureLocation,
  body,
  html,
  json,
  listRuns,
  packageIdentitySchema,
  pathIsLegacyView,
  readOnlyView,
  redirect,
  releaseWorkerResponse,
  runEntryPath,
  script,
  selectAssets,
} from "./service-http-helpers";
import { serviceLog } from "./service-log";
import { cachedVersionDiscovery } from "./service-update";
import { ensureViewerBinding, readViewerBinding, type ViewerBinding } from "./viewer-binding";
import {
  type WorkerDiagnosticStage,
  WorkerDiagnosticStore,
  workerDiagnosticFromError,
} from "./worker-diagnostics";

export { agentLease, listRuns, selectAssets } from "./service-http-helpers";
export async function startSharedViewer(
  state: ServiceState,
  manifest: ReleaseManifest,
  assetsDir: string,
  port: number,
  sourceRevision?: () => string,
  sourceName?: string,
  demoHooks?:
    | ConnectObserver
    | Pick<
        import("../lib/server-contract").DashboardOptions,
        "connectObserver" | "archiveProvider" | "getProfileCapabilities"
      >,
) {
  if ((sourceRevision || demoHooks) && !state.paths.isolated)
    throw new ContractError("INVALID_PROFILE", "Source reload requires an isolated profile");
  state.initialize();
  const auth = new ServiceAuth(state);
  const serviceConfig = (() => {
    try {
      return state.config();
    } catch {
      return {} as any;
    }
  })();
  const versionDiscovery = (() => {
    try {
      return cachedVersionDiscovery(state);
    } catch {
      return undefined;
    }
  })();
  const diagnostics = new WorkerDiagnosticStore(state.paths);
  diagnostics.sweep(undefined, (runId) => existsSync(join(state.paths.data, "runs", runId)));
  const recordDiagnostic = (input: Parameters<WorkerDiagnosticStore["record"]>[0]) => {
    const diagnostic = diagnostics.record(input);
    try {
      serviceLog(
        state.paths,
        "worker_diagnostic",
        state.runtime().generation ?? "unknown-generation",
        manifest.build_id,
        {
          diagnostic_id: diagnostic.diagnostic_id,
          run_id: diagnostic.run_id,
          worker_generation: diagnostic.worker_generation,
          stage: diagnostic.stage,
          error_code: diagnostic.error_code,
          state: diagnostic.state,
          retry_count: diagnostic.retry_count,
        },
      );
    } catch {
      /* Diagnostics remain available through the runtime state file. */
    }
    return diagnostic;
  };
  const fallbackViewer = (() => {
    let previous: string | null = null;
    try {
      if (!sourceRevision && !demoHooks && !state.config().package_name)
        previous = state.config().previous_build;
    } catch {}
    if (!previous || previous === manifest.build_id) return null;
    try {
      const root = join(state.paths.releases, previous);
      const release = verifyRelease(root);
      if (release.schema_version !== 2 || release.build_id !== previous) return null;
      return root;
    } catch {
      return null;
    }
  })();
  const resources = new Map<string, ReturnType<typeof createRunDashboard>>();
  const workerBridges = new Map<
    string,
    (request: Request, runId: string, path: string) => Promise<Response>
  >();
  const workerBuilds = new Map<
    string,
    { build_id: string; package_version: string; release_root: string | null; identity?: unknown }
  >();
  const warnings = new Map<string, string | null>();
  const runtimeConfig = (() => {
    try {
      return state.config();
    } catch {
      return {};
    }
  })();
  const sharedSource: StaticViewerProvenance["source"] | undefined = sourceRevision
    ? "source-preview"
    : undefined;
  const bindingReleases = new Map<string, ReleaseManifest | null>();
  const verifiedPackageBindings = new Set<string>();
  const currentBindingIdentity = {
    package_name: serviceConfig.package_name ?? "@loomhelm/multi-task-flow",
    package_version: serviceConfig.package_version ?? manifest.service_version,
    build_id: manifest.build_id,
    source_sha: serviceConfig.source_sha ?? manifest.source_sha,
    compatibility_line: serviceConfig.compatibility_line ?? "compat-v1",
    ledger_contract: serviceConfig.ledger_contract ?? manifest.ledger_contract ?? CONTRACT_VERSION,
    api_contract: serviceConfig.api_contract ?? manifest.api_versions[0] ?? 1,
    frontend_contract: serviceConfig.frontend_contract ?? manifest.frontend_contracts[0] ?? 1,
    viewer_contract: serviceConfig.viewer_contract ?? manifest.viewer_contract,
  };
  const bindingMismatch = (): never => {
    throw new ContractError(
      "VIEWER_BINDING_IDENTITY_MISMATCH",
      "Run version binding does not match its verified viewer identity",
      2,
    );
  };
  function releaseForBinding(binding: ViewerBinding): ReleaseManifest | null {
    if (bindingReleases.has(binding.build_id)) return bindingReleases.get(binding.build_id) ?? null;
    const root = join(state.paths.releases, binding.build_id);
    if (!existsSync(root)) {
      bindingReleases.set(binding.build_id, null);
      return null;
    }
    try {
      const release = verifyRelease(root);
      if (release.build_id !== binding.build_id) bindingMismatch();
      bindingReleases.set(binding.build_id, release);
      return release;
    } catch (error) {
      if (error instanceof ContractError && error.code === "VIEWER_BINDING_IDENTITY_MISMATCH")
        throw error;
      throw new ContractError(
        "VIEWER_BINDING_RELEASE_INVALID",
        "Run version binding points to an invalid viewer release",
        2,
      );
    }
  }
  function verifyExternalPackageBinding(binding: ViewerBinding): void {
    if (
      binding.package_name !== "@loomhelm/multi-task-flow" ||
      binding.package_version === "source-preview" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(binding.package_version)
    )
      bindingMismatch();
    const key = [
      binding.package_name,
      binding.package_version,
      binding.build_id,
      binding.source_sha,
      binding.compatibility_line,
      binding.ledger_contract,
      binding.api_contract,
      binding.frontend_contract,
      binding.viewer_contract,
    ].join(":");
    if (verifiedPackageBindings.has(key)) return;
    const result = Runtime.spawnSync(
      [
        process.execPath,
        "x",
        "--bun",
        "--package",
        `${binding.package_name}@${binding.package_version}`,
        "multi-task-flow",
        "--version",
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 120_000 },
    );
    if (result.exitCode !== 0) {
      throw new ContractError(
        "VIEWER_BINDING_IDENTITY_UNAVAILABLE",
        "Historical viewer package identity could not be verified",
        2,
      );
    }
    let identity: z.infer<typeof packageIdentitySchema>;
    try {
      identity = packageIdentitySchema.parse(JSON.parse(result.stdout.toString("utf8")));
    } catch {
      throw new ContractError(
        "VIEWER_BINDING_IDENTITY_INVALID",
        "Historical viewer package returned an invalid identity",
        2,
      );
    }
    if (
      identity.package_name !== binding.package_name ||
      identity.version !== binding.package_version ||
      identity.build_id !== binding.build_id ||
      identity.source_sha !== binding.source_sha ||
      identity.compatibility_line !== binding.compatibility_line ||
      identity.contracts.ledger !== binding.ledger_contract ||
      identity.contracts.api !== binding.api_contract ||
      identity.contracts.frontend !== binding.frontend_contract ||
      identity.contracts.viewer !== binding.viewer_contract
    )
      bindingMismatch();
    verifiedPackageBindings.add(key);
  }
  function verifyBindingIdentity(binding: ViewerBinding): ReleaseManifest | null {
    if (binding.build_id === currentBindingIdentity.build_id) {
      if (
        binding.package_name !== currentBindingIdentity.package_name ||
        binding.package_version !== currentBindingIdentity.package_version ||
        binding.source_sha !== currentBindingIdentity.source_sha ||
        binding.compatibility_line !== currentBindingIdentity.compatibility_line ||
        binding.ledger_contract !== currentBindingIdentity.ledger_contract ||
        binding.api_contract !== currentBindingIdentity.api_contract ||
        binding.frontend_contract !== currentBindingIdentity.frontend_contract ||
        binding.viewer_contract !== currentBindingIdentity.viewer_contract
      )
        bindingMismatch();
      return null;
    }
    const release = releaseForBinding(binding);
    if (release) {
      if (release.schema_version !== 2)
        throw new ContractError(
          "VIEWER_BINDING_RELEASE_UNSUPPORTED",
          "Historical viewer release is diagnostic-only and cannot serve a run",
          2,
        );
      if (
        binding.source_sha !== release.source_sha ||
        binding.ledger_contract !== (release.ledger_contract ?? 2) ||
        binding.api_contract !== release.api_versions[0] ||
        binding.frontend_contract !== release.frontend_contracts[0] ||
        binding.viewer_contract !== release.viewer_contract
      )
        bindingMismatch();
      return release;
    }
    verifyExternalPackageBinding(binding);
    return null;
  }
  function boundViewerProvenance(
    binding: ViewerBinding,
    verifiedRelease: ReleaseManifest | null,
  ): StaticViewerProvenance {
    const release = verifiedRelease;
    const source: StaticViewerProvenance["source"] = release
      ? release.schema_version === 1
        ? "legacy-bundle"
        : "package"
      : "package";
    const provenance = {
      schema_version: 1,
      source,
      package_name: binding.package_name,
      package_version: binding.package_version,
      compatibility_line: binding.compatibility_line,
      skill_version: release?.skill_version ?? null,
      viewer_contract: binding.viewer_contract,
      build_id: /^[a-f0-9]{64}$/.test(binding.build_id) ? binding.build_id : null,
      source_sha: /^[a-f0-9]{40}$/.test(binding.source_sha) ? binding.source_sha : null,
    };
    const parsed = staticViewerProvenanceSchema.safeParse(provenance);
    return parsed.success ? parsed.data : unknownStaticViewerProvenance(source);
  }
  function runtimeForRun(id: string, binding: ViewerBinding): RuntimeMetadata {
    safeId(id);
    const verifiedRelease = verifyBindingIdentity(binding);
    const assets = selectAssets(state.paths.data, id, assetsDir);
    if (!assets.source && !sharedSource && binding.build_id !== manifest.build_id)
      return runtimeMetadataFromViewer(
        boundViewerProvenance(binding, verifiedRelease),
        runtimeConfig,
        manifest,
        assets.warning,
      );
    return runtimeMetadata(
      assets.path,
      runtimeConfig,
      manifest,
      assets.warning,
      assets.source ?? sharedSource,
    );
  }
  let timeoutServer: Pick<Awaited<ReturnType<typeof Runtime.serve>>, "timeout"> | undefined;
  let gatewayPort = port;
  function getRun(id: string) {
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
  }
  const workerGeneration = state.runtime().generation ?? createWorkerGeneration();
  const workerPool = new ViewerWorkerPool({
    workerFactory: async (workerKey) => {
      const generation = createWorkerGeneration(workerGeneration);
      const socketPath = viewerWorkerSocketPath(
        join(state.paths.state, "workers"),
        workerKey,
        generation,
      );
      const bridgeToken = randomUUID();
      workerBridges.set(bridgeToken, async (request, runId, path) => {
        const requestUrl = new URL(request.url);
        const route = parseViewerRoute(requestUrl);
        if (!route || route.runId !== runId)
          throw new Error("viewer worker route identity mismatch");
        const run = getRun(runId);
        const normalizedPath =
          requestUrl.pathname.startsWith("/api/v1/") && !route.path.startsWith("/api/")
            ? "/api" + route.path
            : route.path;
        return run.handle(
          request,
          {
            timeout(req, timeout) {
              timeoutServer?.timeout(req, timeout);
            },
          },
          normalizedPath,
        );
      });
      const selected = workerBuilds.get(workerKey) ?? {
        build_id: manifest.build_id,
        package_version: serviceConfig.package_version ?? manifest.service_version,
        release_root: null,
      };
      // Synthetic observers are an explicit test/preview seam. Keep the same
      // Unix-socket contract while retaining the injected observer in-process;
      // production workers never receive demoHooks and always use a child PID.
      if (typeof demoHooks === "function" || (demoHooks && typeof demoHooks === "object")) {
        const server = await startUnixViewerWorkerServer({
          socketPath,
          workerKey,
          generation,
          handle: async (request, context) => {
            const route = parseViewerRoute(new URL(request.url));
            if (!route || route.runId !== context.runId)
              throw new Error("viewer worker route identity mismatch");
            const normalizedPath =
              new URL(request.url).pathname.startsWith("/api/v1/") &&
              !route.path.startsWith("/api/")
                ? "/api" + route.path
                : route.path;
            return getRun(context.runId).handle(
              request,
              {
                timeout(req, timeout) {
                  timeoutServer?.timeout(req, timeout);
                },
              },
              normalizedPath,
            );
          },
        });
        return createUnixViewerWorker({
          socketPath,
          workerKey,
          generation,
          stop: async () => {
            workerBridges.delete(bridgeToken);
            await server.stop();
          },
        });
      }
      const childCommand =
        selected.build_id === manifest.build_id
          ? [
              process.execPath,
              new URL("../scripts/viewer-worker-process.ts", import.meta.url).pathname,
            ]
          : selected.release_root
            ? [
                process.execPath,
                join(
                  selected.release_root,
                  "skills/multi-task-flow/scripts/viewer-worker-process.ts",
                ),
              ]
            : [
                process.execPath,
                "x",
                "--bun",
                "--package",
                `@loomhelm/multi-task-flow@${selected.package_version}`,
                "multi-task-flow",
                "worker-process",
              ];
      const child = Bun.spawn(childCommand, {
        env: {
          ...process.env,
          LOOMHELM_CALLER_IDENTITY: JSON.stringify(selected.identity ?? null),
          MTF_WORKER_SOCKET: socketPath,
          MTF_WORKER_KEY: workerKey,
          MTF_WORKER_GENERATION: generation,
          MTF_WORKER_DATA_ROOT: state.paths.data,
          MTF_WORKER_PORT: String(gatewayPort),
          ...(selected.build_id === manifest.build_id
            ? { MTF_WORKER_ASSETS: assetsDir }
            : selected.release_root
              ? { MTF_WORKER_ASSETS: join(selected.release_root, "skills/multi-task-flow/dist") }
              : {}),
        },
        stdout: "ignore",
        stderr: "ignore",
      });
      const deadline = Date.now() + 1_500;
      while (!existsSync(socketPath) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (!existsSync(socketPath)) {
        child.kill();
        workerBridges.delete(bridgeToken);
        throw new Error("viewer worker failed to start");
      }
      return createUnixViewerWorker({
        socketPath,
        workerKey,
        generation,
        stop: async () => {
          workerBridges.delete(bridgeToken);
          child.kill();
          await child.exited;
        },
      });
    },
  });
  let server: Awaited<ReturnType<typeof Runtime.serve>>;
  try {
    server = await Runtime.serve({
      hostname: "127.0.0.1",
      port,
      async fetch(request, currentServer) {
        timeoutServer = currentServer;
        gatewayPort = currentServer.port;
        const host = `127.0.0.1:${currentServer.port}`;
        const origin = request.headers.get("origin");
        if (request.headers.get("host") !== host || (origin && origin !== `http://${host}`))
          return json({ code: "FORBIDDEN" }, 403);
        const url = new URL(request.url);
        if (url.pathname === "/__internal/worker" && request.method !== "OPTIONS") {
          const token = request.headers.get("x-mtf-worker-token");
          const runId = request.headers.get("x-mtf-worker-run-id");
          const workerPath = request.headers.get("x-mtf-worker-path");
          const bridge = token ? workerBridges.get(token) : undefined;
          if (!bridge || !runId || !workerPath)
            return json({ code: "WORKER_BRIDGE_UNAUTHORIZED" }, 403);
          const body =
            request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
          const forwarded = new Request(`http://${host}${workerPath}`, {
            method: request.method,
            headers: request.headers,
            ...(body ? { body, duplex: "half" as const } : {}),
          });
          return await bridge(forwarded, runId, workerPath);
        }
        let diagnosticResponse: ReturnType<WorkerDiagnosticStore["get"]> = null;
        try {
          if (
            url.pathname === "/login" ||
            url.pathname === "/login.js" ||
            url.pathname === "/resume-task.js" ||
            url.pathname === "/api/v1/login"
          )
            return json({ code: "NOT_FOUND" }, 404);
          const viewerEntry =
            request.method === "GET" && (url.pathname === "/" || runEntryPath.test(url.pathname));
          if (request.method === "GET" && url.pathname === "/auth/failed") {
            const redirectValues = url.searchParams.getAll("redirect");
            const hasOnlyRedirect = [...url.searchParams.keys()].every((key) => key === "redirect");
            const target =
              hasOnlyRedirect && redirectValues.length === 1
                ? parseViewerTarget(redirectValues[0]!, `http://${host}`, { allowHome: false })
                    ?.target
                : null;
            if (!target) return html(authFailedPage, 400);
            const actor = auth.authorize(request);
            return actor ? redirect(target) : html(authFailedPage, 401);
          }
          const viewerTarget = viewerEntry
            ? parseViewerTarget(request.url, `http://${host}`, { allowTicket: true })
            : null;
          const actor = auth.authorize(request);
          if (viewerEntry && !viewerTarget) {
            if (!actor) return html(authFailedPage, 400);
            return json({ code: "INVALID_REDIRECT" }, 400);
          }
          if (viewerEntry && viewerTarget) {
            if (actor) {
              if (viewerTarget.ticket !== null) {
                auth.consumeTicket(viewerTarget.ticket, url.pathname);
                return redirect(viewerTarget.target);
              }
            } else if (viewerTarget.ticket !== null) {
              try {
                const session = auth.exchange(viewerTarget.ticket, url.pathname);
                return redirect(viewerTarget.target, { "Set-Cookie": session.cookie });
              } catch (error) {
                if (!(error instanceof ContractError) || error.code !== "INVALID_TICKET")
                  throw error;
                if (url.pathname === "/") return html(authFailedPage, 401);
                return redirect(authFailureLocation(viewerTarget.target));
              }
            } else if (url.pathname !== "/") {
              return redirect(authFailureLocation(viewerTarget.target));
            }
          }
          if (url.pathname === "/api/v1/reconnect" && request.method === "POST") {
            if (!request.headers.get("cookie")) return json({ code: "UNAUTHENTICATED" }, 401);
            const target = parseViewerTarget(
              url.searchParams.get("target") ?? "/",
              `http://${host}`,
              { allowHome: false },
            )?.target;
            if (!target) return json({ code: "INVALID_TARGET" }, 400);
            const targetPath = new URL(target, `http://${host}`).pathname;
            const ticket = auth.ticket(targetPath);
            return json({
              login_url: `http://${host}${target}${target.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`,
              expires_in_seconds: 60,
              single_use: true,
            });
          }
          if (!actor)
            return request.method === "GET" && !url.pathname.startsWith("/api/")
              ? html(
                  viewerPage(
                    "需要连接本地展示服务",
                    "<p>请通过 service login 获取一次性登录入口；登录后将恢复任务定位。若在其他标签页登录，请返回此页刷新。</p>",
                  ),
                  401,
                )
              : json({ code: "UNAUTHENTICATED" }, 401);
          if (request.method !== "GET" && actor.kind === "browser" && origin !== `http://${host}`)
            return json({ code: "FORBIDDEN" }, 403);
          if (sourceRevision && request.method === "GET" && url.pathname === "/api/v1/source")
            return json({ revision: sourceRevision(), name: sourceName });
          if (sourceRevision && request.method === "GET" && url.pathname === "/source-client.js")
            return script(
              `document.title=${JSON.stringify(sourceName ?? "源码开发预览")};let previous=${JSON.stringify(sourceRevision())};setInterval(async()=>{try{const response=await fetch('/api/v1/source');if(!response.ok)return;const value=await response.json();if(previous&&previous!==value.revision)location.reload();previous=value.revision}catch{}},1000);`,
            );
          if (url.pathname === "/api/v1/status" && request.method === "GET") {
            if (actor.kind !== "cli") return json({ code: "FORBIDDEN" }, 403);
            return json({
              ok: true,
              build_id: manifest.build_id,
              source_sha: manifest.source_sha,
              package_name: state.config().package_name,
              package_version: state.config().package_version,
              compatibility_line: state.config().compatibility_line,
              skill_version: state.config().skill_version ?? manifest.skill_version,
              service_contract: state.config().service_contract ?? String(manifest.service_version),
              skill_id: manifest.skill_id,
              ledger_contract: manifest.ledger_contract,
              viewer_contract: manifest.viewer_contract,
              compatibility,
              generation: state.runtime().generation,
              pid: process.pid,
              port: currentServer.port,
            });
          }
          if (url.pathname === "/api/v1/lease" && request.method === "POST") {
            if (actor.kind === "browser") return json(state.renewBrowser(actor.id));
            const input = agentInput.parse(await body(request));
            requireApi(input.api_version);
            return json(state.renew(agentLease(input), state.config().agent_ttl_ms));
          }
          if (url.pathname === "/api/v1/runs" && request.method === "GET") {
            const offset = Number(url.searchParams.get("offset") ?? 0);
            if (!Number.isInteger(offset) || offset < 0)
              return json({ code: "INVALID_OFFSET" }, 400);
            const listed = listRuns(state.paths.data, offset);
            return json({
              ...listed,
              runs: listed.runs.map((run) => ({
                ...run,
                viewer_binding: (() => {
                  try {
                    return readViewerBinding(state, run.id);
                  } catch {
                    return null;
                  }
                })(),
              })),
              gateway: {
                package_name: serviceConfig.package_name,
                package_version: serviceConfig.package_version,
                build_id: manifest.build_id,
                compatibility_line: serviceConfig.compatibility_line,
              },
              ...(versionDiscovery
                ? {
                    update_hint: {
                      surface: "gateway",
                      current: {
                        package_version: serviceConfig.package_version ?? null,
                        build_id: manifest.build_id,
                        source_sha: manifest.source_sha,
                        compatibility_line: serviceConfig.compatibility_line ?? null,
                        viewer_contract: manifest.viewer_contract,
                      },
                      target:
                        versionDiscovery.compatible_version ??
                        versionDiscovery.latest_version ??
                        null,
                      compatible: versionDiscovery.compatible_version ? true : "unknown",
                      reason: "registry_discovery",
                      command: "multi-task-flow gateway upgrade",
                    },
                  }
                : {}),
            });
          }
          if (request.method === "GET" && url.pathname === "/") return html(homePage);
          if (request.method === "GET" && url.pathname === "/home.js") return script(homeScript);
          if (request.method === "GET" && url.pathname === "/service-client.js")
            return script(runClientScript);
          const match = url.pathname.match(
            /^\/(?:api\/v1\/)?runs\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/(.*)$/,
          );
          if (!match) return json({ code: "NOT_FOUND" }, 404);
          const id = match[1]!;
          if (pathIsLegacyView(url.pathname, request.method)) {
            if (!fallbackViewer) return json({ code: "LEGACY_VIEW_UNAVAILABLE" }, 404);
            let raw: unknown;
            try {
              raw = JSON.parse(new LedgerStore(state.paths.data, id).readRaw());
            } catch {
              throw new ContractError("LEDGER_UNREADABLE", "Stored run ledger is unreadable", 2);
            }
            return json({
              run_id: id,
              build_id: manifest.build_id,
              fallback_build_id: state.config().previous_build,
              read_only: true,
              view: readOnlyView(fallbackViewer, raw, url.searchParams.get("plan") ?? undefined),
            });
          }
          let path = "/" + match[2]!;
          if (url.pathname.startsWith("/api/v1/")) path = "/api/" + match[2]!;
          if (path === "/api/service" && request.method === "GET") {
            const binding = ensureViewerBinding(state, id, {
              package_name: serviceConfig.package_name ?? "@loomhelm/multi-task-flow",
              package_version: serviceConfig.package_version ?? manifest.service_version,
              build_id: manifest.build_id,
              source_sha: manifest.source_sha,
              compatibility_line: serviceConfig.compatibility_line ?? "compat-v1",
              ledger_contract: manifest.ledger_contract,
              api_contract: manifest.api_versions[0] ?? 1,
              frontend_contract: manifest.frontend_contracts[0] ?? 1,
              viewer_contract: manifest.viewer_contract,
            });
            const runtime = runtimeForRun(id, binding);
            return json({
              surface: "orchestration",
              current: binding,
              daemon: {
                package_name: serviceConfig.package_name,
                package_version: serviceConfig.package_version,
                build_id: manifest.build_id,
                compatibility_line: serviceConfig.compatibility_line,
              },
              warning: runtime.warning ?? warnings.get(id) ?? null,
              runtime,
              ...(versionDiscovery
                ? {
                    update_hint: {
                      surface: "orchestration",
                      current: {
                        package_version: binding.package_version,
                        build_id: binding.build_id,
                        source_sha: binding.source_sha,
                        compatibility_line: binding.compatibility_line,
                        viewer_contract: binding.viewer_contract,
                      },
                      target:
                        versionDiscovery.compatible_version ??
                        versionDiscovery.latest_version ??
                        null,
                      compatible: versionDiscovery.compatible_version ? true : "unknown",
                      reason: "registry_discovery",
                      command: "multi-task-flow orchestration upgrade --run-id",
                    },
                  }
                : {}),
            });
          }
          if (path === "/api/diagnostics/worker" && request.method === "GET") {
            const requestedRun = url.searchParams.get("run_id") ?? id;
            if (requestedRun !== id) return json({ code: "FORBIDDEN" }, 403);
            new LedgerStore(state.paths.data, id).read();
            return json({ diagnostic: diagnostics.get(id) });
          }
          if (path === "/api/lease" && request.method === "POST" && actor.kind === "browser")
            return json(state.renewBrowser(actor.id));
          const ledger = new LedgerStore(state.paths.data, id).read();
          requireLedgerCompatibility(ledger);
          const binding = ensureViewerBinding(state, id, {
            package_name: serviceConfig.package_name ?? "@loomhelm/multi-task-flow",
            package_version: serviceConfig.package_version ?? manifest.service_version,
            build_id: manifest.build_id,
            source_sha: manifest.source_sha,
            compatibility_line: serviceConfig.compatibility_line ?? "compat-v1",
            ledger_contract: manifest.ledger_contract,
            api_contract: manifest.api_versions[0] ?? 1,
            frontend_contract: manifest.frontend_contracts[0] ?? 1,
            viewer_contract: manifest.viewer_contract,
          });
          if (ledger.contract_version >= 4) requireRunIdentity(ledger, identityOf(binding) as any);
          getRun(id); // Gateway owns lifecycle observation; the selected Worker owns response rendering.
          const assets = selectAssets(state.paths.data, id, assetsDir);
          const verifiedRelease = verifyBindingIdentity(binding);
          const usesCurrentAssets = Boolean(assets.source || sharedSource);
          // Static assets do not select executable identity for a bound contract-4 run.
          const workerBuildId =
            ledger.contract_version >= 4
              ? binding.build_id
              : usesCurrentAssets
                ? manifest.build_id
                : binding.build_id;
          const workerPackageVersion =
            workerBuildId === manifest.build_id
              ? (serviceConfig.package_version ?? manifest.service_version)
              : binding.package_version;
          const version = dataVersionOf(ledger, binding.viewer_contract, workerBuildId);
          const workerKey = workerKeyOf(version);
          workerBuilds.set(workerKey, {
            identity:
              workerBuildId === manifest.build_id ? currentBindingIdentity : identityOf(binding),
            build_id: workerBuildId,
            package_version: workerPackageVersion,
            release_root:
              workerBuildId === binding.build_id && verifiedRelease?.schema_version === 2
                ? join(state.paths.releases, binding.build_id)
                : null,
          });
          let workerStage: WorkerDiagnosticStage = "worker_select";
          let lease: Awaited<ReturnType<typeof workerPool.acquire>>;
          try {
            lease = await workerPool.acquire(workerKey);
            workerStage = "request_dispatch";
          } catch (error) {
            const diagnostic = recordDiagnostic(
              workerDiagnosticFromError({
                run_id: id,
                worker_key: workerKey,
                worker_generation: workerPool.generation(workerKey) ?? "unknown-generation",
                stage:
                  error instanceof Error && /socket (connection|connect)/i.test(error.message)
                    ? "socket_connect"
                    : workerStage,
                retry_count: workerPool.failureCount(workerKey),
                retryable: workerPool.failureCount(workerKey) < 3,
                reconnect_required: true,
                state: workerPool.failureCount(workerKey) >= 3 ? "degraded" : undefined,
                error,
              }),
            );
            diagnosticResponse = diagnostic;
            throw error;
          }
          let response: Response;
          try {
            response = await lease.worker.handle(request, currentServer, path, {
              runId: id,
              workerKey,
              generation: lease.generation,
            });
          } catch (error) {
            lease.release();
            await workerPool.invalidate(workerKey, lease.generation);
            diagnosticResponse = recordDiagnostic(
              workerDiagnosticFromError({
                run_id: id,
                worker_key: workerKey,
                worker_generation: lease.generation,
                stage:
                  error instanceof Error &&
                  /socket (connection|connect|closed|timeout)/i.test(error.message)
                    ? "socket_connect"
                    : "request_dispatch",
                retry_count: workerPool.failureCount(workerKey),
                retryable: workerPool.failureCount(workerKey) < 3,
                reconnect_required: true,
                state: workerPool.failureCount(workerKey) >= 3 ? "degraded" : undefined,
                error,
              }),
            );
            throw error;
          }
          const leasedResponse = releaseWorkerResponse(response, lease.release, async () => {
            await workerPool.invalidate(workerKey, lease.generation);
            recordDiagnostic(
              workerDiagnosticFromError({
                run_id: id,
                worker_key: workerKey,
                worker_generation: lease.generation,
                stage: "response_stream",
                retry_count: workerPool.failureCount(workerKey),
                retryable: workerPool.failureCount(workerKey) < 3,
                reconnect_required: true,
                state: workerPool.failureCount(workerKey) >= 3 ? "degraded" : undefined,
                error: new Error("worker response stream failed"),
              }),
            );
          });
          if (path !== "/api/events") {
            const beforeRecovery = diagnostics.get(id);
            const recovered = beforeRecovery ? diagnostics.recover(id, beforeRecovery) : null;
            if (recovered) {
              try {
                serviceLog(
                  state.paths,
                  "worker_diagnostic",
                  state.runtime().generation ?? "unknown-generation",
                  manifest.build_id,
                  {
                    diagnostic_id: recovered.diagnostic_id,
                    run_id: recovered.run_id,
                    worker_generation: recovered.worker_generation,
                    stage: recovered.stage,
                    error_code: recovered.error_code,
                    safe_summary: recovered.safe_summary,
                    retryable: recovered.retryable,
                    reconnect_required: recovered.reconnect_required,
                    worker_key: recovered.worker_key,
                    retry_count: recovered.retry_count,
                    state: recovered.state,
                    recovered_at: recovered.recovered_at,
                  },
                );
              } catch {
                /* Do not turn a recovered request into a logging failure. */
              }
            }
          }
          if (
            path === "/" &&
            leasedResponse.ok &&
            leasedResponse.headers.get("content-type")?.startsWith("text/html")
          ) {
            return html(
              (await leasedResponse.text()) +
                '<script src="/service-client.js" defer></script>' +
                (sourceRevision ? '<script src="/source-client.js" defer></script>' : ""),
            );
          }
          return leasedResponse;
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
          if (code === "SERVICE_ERROR" && diagnosticResponse)
            return workerFailureResponse(
              request,
              diagnosticResponse,
              workerPool.retryAfterMs(diagnosticResponse.worker_key),
            );
          return json(
            {
              code:
                code === "SERVICE_ERROR" && diagnosticResponse ? "RUN_WORKER_UNAVAILABLE" : code,
              ...(diagnosticResponse
                ? {
                    diagnostic_id: diagnosticResponse.diagnostic_id,
                    run_id: diagnosticResponse.run_id,
                    stage: diagnosticResponse.stage,
                    worker_key: diagnosticResponse.worker_key,
                    worker_generation: diagnosticResponse.worker_generation,
                    error_code: diagnosticResponse.error_code,
                    safe_summary: diagnosticResponse.safe_summary,
                    retry_count: diagnosticResponse.retry_count,
                    state: diagnosticResponse.state,
                    retryable: diagnosticResponse.retryable,
                    reconnect_required: diagnosticResponse.reconnect_required,
                  }
                : {}),
            },
            status,
          );
        }
      },
    });
  } catch (error) {
    await workerPool.stop();
    throw error;
  }
  return {
    port: server.port!,
    get watcherCount() {
      return [...resources.values()].filter((run) => run.subscriberCount > 0).length;
    },
    async stop() {
      await server.stop(true);
      await workerPool.stop();
      for (const run of resources.values()) run.stop();
      resources.clear();
      warnings.clear();
    },
  };
}
