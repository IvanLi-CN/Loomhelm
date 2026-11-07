import { Runtime } from "../../../bin/modules/core/runtime";
import {
  ConversationOutputs,
  type ConnectObserver,
} from "./conversation-output";
import { handleProfileRequest, profileErrorResponse } from "./profile-http";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  realpathSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { join, resolve } from "node:path";
import { ContractError, requireCondition } from "./errors";
import { LedgerStore, safeId } from "./store";
import { validateLedger } from "./schema";
import { buildView } from "./view";
import { sweepConversationArchives, retryConversationArchive } from "./conversation-archive";
import { z } from "zod";
import { GlobalPreferencesStore, parseThemePayload } from "./preferences";
import {
  readBodyWithinLimit,
  readRegisteredDocument,
  readSafeFile,
  safeCompare,
} from "./server-files";

export { dashboardHeaders, type DashboardOptions } from "./server-contract";
import {
  dashboardHeaders,
  contentTypes,
  maxPreferenceBodyBytes,
  type DashboardOptions,
} from "./server-contract";

export function createRunDashboard(options: DashboardOptions) {
  const headers = dashboardHeaders;
  const store = new LedgerStore(options.root, safeId(options.runId));
  validateLedger(store.read());
  const preferences = new GlobalPreferencesStore(options.root);
  const token = options.token ?? randomBytes(24).toString("base64url");
  requireCondition(
    /^[A-Za-z0-9_-]{22,}$/.test(token),
    "INVALID_TOKEN",
    "Dashboard token is invalid",
  );
  const assetRoot = realpathSync(options.assetsDir);
  requireCondition(
    assetRoot === resolve(options.assetsDir),
    "UNSAFE_PATH",
    "Dashboard assets must not traverse symlinks",
  );
  const responseHeaders = options.demoFrame
    ? {
        ...headers,
        "Content-Security-Policy": headers["Content-Security-Policy"].replace(
          "frame-ancestors 'none'",
          "frame-ancestors 'self'",
        ),
      }
    : headers;
  const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let watching = true;
  let watchHealthy = true;
  let lastRevision = validateLedger(store.read()).revision;
  const publish = (event: string, data: unknown) => {
    const bytes = encoder.encode(
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    );
    for (const controller of subscribers) {
      try {
        controller.enqueue(bytes);
      } catch {
        subscribers.delete(controller);
      }
    }
  };
  const outputs = new ConversationOutputs(
    (snapshot) => publish("agent-output", snapshot),
    options.connectObserver,
  );
  let archiveRunning = false;
  let lastArchiveSweep = 0;
  const archivePendingConversations = async (): Promise<void> => {
    if (options.readOnly || archiveRunning || Date.now() - lastArchiveSweep < 1000) return;
    archiveRunning = true;
    lastArchiveSweep = Date.now();
    try {
      await sweepConversationArchives(store, options.archiveProvider);
    } catch { /* Durable intent and resource diagnostics survive observer restarts. */ }
    finally { archiveRunning = false; }
  };
  outputs.bind(validateLedger(store.read()).tasks);
  let watcher: FSWatcher | null = null;
  const closeWatcher = (): void => {
    if (!watcher) return;
    watcher.close();
    watcher = null;
  };
  const watchDirectory = (): void => {
    try {
      closeWatcher();
      watcher = watch(store.runPath, (_event, name) => {
        if (!name || name.toString() === "ledger.json") {
          try {
            const ledger = validateLedger(store.read());
            outputs.bind(ledger.tasks);
            if (subscribers.size) outputs.start();
            lastRevision = ledger.revision;
            watching = watchHealthy;
            publish("revision", { revision: lastRevision, watching });
            void archivePendingConversations();
          } catch {
            watching = false;
            publish("stale", { reason: "ledger_unreadable" });
          }
        }
      });
      watcher.on("error", () => {
        watchHealthy = false;
        watching = false;
        closeWatcher();
        publish("stale", { reason: "watch_failed" });
      });
      watchHealthy = true;
    } catch {
      watcher = null;
      watchHealthy = false;
      watching = false;
      publish("stale", { reason: "watch_failed" });
    }
  };
  void archivePendingConversations();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const activate = () => {
    if (heartbeat) return;
    outputs.start();
    watchDirectory();
    heartbeat = setInterval(() => {
      if (!watchHealthy) watchDirectory();
      try {
        const ledger = validateLedger(store.read());
        outputs.bind(ledger.tasks);
        if (subscribers.size) outputs.start();
        const revision = ledger.revision;
        const recovered = !watching && watchHealthy;
        watching = watchHealthy;
        if (revision !== lastRevision || recovered) {
          lastRevision = revision;
          publish("revision", { revision, watching });
        }
      } catch {
        watching = false;
        publish("stale", { reason: "ledger_unreadable" });
      }
      void archivePendingConversations();
      publish("heartbeat", { watching });
    }, 15_000);
  };
  const handle = async (
    request: Request,
    currentServer: Pick<Awaited<ReturnType<typeof Runtime.serve>>, "timeout">,
    path: string,
  ): Promise<Response> => {
    const url = new URL(request.url);
    try {
      if (path === "/api/preferences") {
        if (request.method === "GET")
          return Response.json(preferences.read(), {
            headers: responseHeaders,
          });
        if (request.method !== "POST")
          return new Response("Method not allowed", {
            status: 405,
            headers,
          });
        const declaredLength = Number(request.headers.get("content-length"));
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > maxPreferenceBodyBytes
        )
          return Response.json(
            { error: "preferences_body_too_large" },
            { status: 413, headers },
          );
        let payload: unknown;
        try {
          const body = await readBodyWithinLimit(
            request,
            maxPreferenceBodyBytes,
          );
          if (body === null)
            return Response.json(
              { error: "preferences_body_too_large" },
              { status: 413, headers },
            );
          payload = JSON.parse(body);
        } catch {
          return Response.json(
            { error: "invalid_preferences" },
            { status: 400, headers },
          );
        }
        const saved = preferences.write(parseThemePayload(payload));
        return Response.json(saved, { headers: responseHeaders });
      }
      if (path === "/api/execution-profile") {
        return await handleProfileRequest(
          request,
          options,
          store,
          responseHeaders,
          (revision) => publish("revision", { revision, watching }),
        );
      }
      if (path === "/api/conversation-archive") {
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers });
        requireCondition(!options.readOnly, "READ_ONLY_SOURCE", "External source viewers are read-only", 3);
        const raw = await readBodyWithinLimit(request, 8192);
        if (raw === null) return Response.json({ error: "request_body_too_large" }, { status: 413, headers });
        const parsed = z.object({ task_id: z.string().min(1) }).strict().parse(JSON.parse(raw));
        const result = await retryConversationArchive(store, parsed.task_id, options.archiveProvider);
        publish("revision", { revision: validateLedger(store.read()).revision, watching });
        return Response.json(result, { headers });
      }
      if (request.method !== "GET")
        return new Response("Method not allowed", { status: 405, headers });
      if (options.demoFrame && path === "/mobile-demo")
        return new Response(
          '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Mobile demo</title><style>body{margin:0;background:#f5f7f6}iframe{display:block;width:393px;height:852px;border:0}</style><iframe title="任务编排移动视图" src="./"></iframe></html>',
          {
            headers: {
              ...responseHeaders,
              "Content-Type": "text/html; charset=utf-8",
            },
          },
        );
      if (path === "/api/view") {
        const selected = url.searchParams.get("plan") ?? undefined;
        if (selected) safeId(selected);
        const ledger = validateLedger(store.read());
        outputs.bind(ledger.tasks);
        if (subscribers.size) outputs.start();
        const snapshot = outputs.snapshot();
        return Response.json(
          {
            revision: ledger.revision,
            generated_at: new Date().toISOString(),
            watching,
            active_plan_id: ledger.active_plan_id,
            execution_plan_id: ledger.execution_plan_id,
            output_epoch: snapshot.output_epoch,
            output_revision: snapshot.output_revision,
            view: {
              ...buildView(ledger, selected, snapshot.outputs),
              profile_read_only:
                options.readOnly === true || !ledger.config.execution_profile,
            },
          },
          { headers: responseHeaders },
        );
      }
      if (path === "/api/events") {
        activate();
        const initialRevision = validateLedger(store.read()).revision;
        currentServer.timeout(request, 0);
        let current: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            current = controller;
            subscribers.add(controller);
            publish("agent-output", outputs.snapshot());
            controller.enqueue(
              encoder.encode(
                `event: revision\ndata: ${JSON.stringify({ revision: initialRevision, watching })}\n\n`,
              ),
            );
          },
          cancel() {
            if (current) subscribers.delete(current);
            if (!subscribers.size) {
              closeWatcher();
              clearInterval(heartbeat);
              heartbeat = undefined;
              outputs.stop();
            }
          },
        });
        return new Response(stream, {
          headers: {
            ...responseHeaders,
            "Content-Type": "text/event-stream",
          },
        });
      }
      if (path.startsWith("/api/document/")) {
        const document = readRegisteredDocument(
          store,
          path.slice("/api/document/".length),
        );
        return document === null
          ? new Response("Not found", { status: 404, headers })
          : new Response(document, {
              headers: {
                ...headers,
                "Content-Type": "text/plain; charset=utf-8",
              },
            });
      }
      const asset =
        path === "/" || path === ""
          ? "index.html"
          : path.startsWith("/assets/")
            ? path.slice(8)
            : "";
      if (!(asset in contentTypes))
        return new Response("Not found", { status: 404, headers });
      const file = join(assetRoot, asset);
      if (
        !existsSync(file) ||
        lstatSync(file).isSymbolicLink() ||
        realpathSync(file) !== file
      )
        return new Response("Not found", { status: 404, headers });
      const contentType = contentTypes[asset];
      if (!contentType)
        return new Response("Not found", { status: 404, headers });
      const content = readSafeFile(file);
      if (!content) return new Response("Not found", { status: 404, headers });
      const bytes = new Uint8Array(content.byteLength);
      bytes.set(content);
      return new Response(new Blob([bytes.buffer]), {
        headers: { ...responseHeaders, "Content-Type": contentType },
      });
    } catch (error) {
      if (path === "/api/execution-profile" || path === "/api/conversation-archive") {
        return profileErrorResponse(error, headers);
      }
      const status =
        error instanceof ContractError &&
        ["PLAN_NOT_FOUND", "INVALID_ID"].includes(error.code)
          ? 404
          : error instanceof ContractError &&
              error.code === "INVALID_PREFERENCES"
            ? 400
            : 503;
      return Response.json(
        {
          error:
            status === 404
              ? "not_found"
              : status === 400
                ? "invalid_preferences"
                : "ledger_unavailable",
        },
        { status, headers },
      );
    }
  };
  return {
    handle,
    token,
    get subscriberCount() {
      return subscribers.size;
    },
    stop() {
      outputs.stop();
      closeWatcher();
      clearInterval(heartbeat);
      for (const controller of subscribers) {
        try {
          controller.close();
        } catch {}
      }
      subscribers.clear();
    },
  };
}

export async function startDashboard(options: DashboardOptions) {
  const run = createRunDashboard(options);
  let server: Awaited<ReturnType<typeof Runtime.serve>>;
  try {
    server = await Runtime.serve({
      hostname: "127.0.0.1",
      port: options.port,
      fetch(request, currentServer) {
        const host = `127.0.0.1:${currentServer.port}`;
        const origin = request.headers.get("origin");
        if (
          request.headers.get("host") !== host ||
          (origin && origin !== `http://${host}`)
        )
          return new Response("Forbidden", {
            status: 403,
            headers: dashboardHeaders,
          });
        const url = new URL(request.url);
        const parts = url.pathname.split("/");
        if (parts[1] !== "s" || !safeCompare(parts[2] ?? "", run.token))
          return new Response("Not found", {
            status: 404,
            headers: dashboardHeaders,
          });
        return run.handle(
          request,
          currentServer,
          "/" + parts.slice(3).join("/"),
        );
      },
    });
  } catch (error) {
    run.stop();
    throw error;
  }
  return {
    port: server.port!,
    token: run.token,
    async stop() {
      run.stop();
      await server.stop(true);
    },
  };
}
