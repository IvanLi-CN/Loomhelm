import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ContractError } from "../lib/errors";
import type { StaticViewerProvenance } from "../lib/runtime-metadata";
import { dashboardHeaders } from "../lib/server";
import { readBodyWithinLimit } from "../lib/server-files";
import { requireApi, requireLedgerCompatibility } from "../lib/service-contract";
import { LedgerStore, readRegular, safeId } from "../lib/store";

export const json = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(value, { status, headers: { ...dashboardHeaders, ...extra } });
export const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      ...dashboardHeaders,
      "Content-Type": "text/html; charset=utf-8",
    },
  });
export const script = (body: string) =>
  new Response(body, {
    headers: {
      ...dashboardHeaders,
      "Content-Type": "text/javascript; charset=utf-8",
    },
  });
export const redirect = (location: string, extra: Record<string, string> = {}) =>
  new Response(null, {
    status: 302,
    headers: { ...dashboardHeaders, Location: location, ...extra },
  });
export const runEntryPath = /^\/runs\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/$/;
export const authFailureLocation = (target: string) =>
  "/auth/failed?" + new URLSearchParams({ redirect: target });
export const agentInput = z
  .object({
    thread_id: z.string().min(1),
    run_id: z.string().min(1),
    api_version: z.literal(1),
  })
  .strict();
const exactPackageVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const packageIdentitySchema = z
  .object({
    package_name: z.literal("@loomhelm/multi-task-flow"),
    version: z.string().regex(exactPackageVersion),
    source_sha: z.string().regex(/^[a-f0-9]{40}$/),
    compatibility_line: z.string().regex(/^compat-v\d+$/),
    build_id: z.string().regex(/^[a-f0-9]{64}$/),
    contracts: z
      .object({
        ledger: z.number().int().positive(),
        api: z.number().int().positive(),
        frontend: z.number().int().positive(),
        viewer: z.number().int().positive(),
      })
      .passthrough(),
  })
  .passthrough();
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
export async function body(request: Request): Promise<unknown> {
  const value = await readBodyWithinLimit(request, 8192);
  if (value === null) throw new ContractError("BODY_TOO_LARGE", "Request too large");
  return JSON.parse(value);
}
export function listRuns(root: string, offset = 0) {
  const runsPath = join(root, "runs");
  if (!existsSync(runsPath)) return { runs: [], total: 0 };
  const entries = readdirSync(runsPath, { withFileTypes: true })
    .filter((item) => item.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(item.name))
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
          error: error instanceof ContractError ? error.code : "LEDGER_UNAVAILABLE",
        };
      }
    }),
  };
}

export function selectAssets(
  root: string,
  runId: string,
  shared: string,
): { path: string; warning: string | null; source?: StaticViewerProvenance["source"] } {
  const custom = join(root, "runs", safeId(runId), "view");
  if (!existsSync(custom)) return { path: shared, warning: null };
  try {
    if (!lstatSync(custom).isDirectory() || lstatSync(custom).isSymbolicLink()) throw new Error();
    const manifest = z
      .object({ api_version: z.literal(1), frontend_contract: z.literal(1) })
      .strict()
      .parse(JSON.parse(readRegular(join(custom, "view.manifest.json"))));
    requireApi(manifest.api_version);
    return { path: custom, warning: null, source: "custom-view" };
  } catch {
    return {
      path: shared,
      warning: "自定义视图未声明兼容合同或不兼容，已使用共享模板。",
    };
  }
}

export function readOnlyView(releaseRoot: string, ledger: unknown, planId?: string) {
  const result = spawnSync(join(releaseRoot, "viewer"), ["read-only-view", "--input", "-"], {
    input: JSON.stringify({ ledger, ...(planId ? { plan_id: planId } : {}) }),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, BUN_OPTIONS: "", NODE_OPTIONS: "" },
  });
  if (result.status !== 0)
    throw new ContractError("LEDGER_UNREADABLE", "Legacy viewer could not read this run", 2);
  try {
    const parsed = z
      .object({
        ok: z.literal(true),
        code: z.literal("OK"),
        result: z.object({ view: z.record(z.string(), z.unknown()) }).strict(),
      })
      .strict()
      .parse(JSON.parse(result.stdout));
    const view = parsed.result.view as { orchestration?: { id?: unknown; revision?: unknown } };
    if (
      view.orchestration?.id !== (ledger as { orchestration_id?: unknown }).orchestration_id ||
      view.orchestration?.revision !== (ledger as { revision?: unknown }).revision
    )
      throw new ContractError("LEDGER_UNREADABLE", "Legacy viewer returned a stale view", 2);
    return parsed.result.view;
  } catch {
    throw new ContractError("LEDGER_UNREADABLE", "Legacy viewer returned no readable view", 2);
  }
}

export function pathIsLegacyView(pathname: string, method: string): boolean {
  return method === "GET" && /\/legacy-view\/?$/.test(pathname);
}

export function releaseWorkerResponse(
  response: Response,
  release: () => void,
  onFailure?: () => void | Promise<unknown>,
): Response {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    release();
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
        } else controller.enqueue(chunk.value);
      } catch (error) {
        finish();
        void Promise.resolve(onFailure?.()).catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
