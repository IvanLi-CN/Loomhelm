import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readRegular, withExclusiveLock, writeAtomic } from "../lib/store";
import type { ServicePaths } from "../lib/service-paths";

export const workerDiagnosticStageSchema = z.enum([
  "worker_select",
  "socket_start",
  "socket_connect",
  "request_dispatch",
  "response_stream",
  "worker_stop",
]);
export type WorkerDiagnosticStage = z.infer<typeof workerDiagnosticStageSchema>;
export const workerDiagnosticStateSchema = z.enum(["observed", "retrying", "degraded", "recovered"]);
export type WorkerDiagnosticState = z.infer<typeof workerDiagnosticStateSchema>;
export const workerDiagnosticSchema = z.object({
  diagnostic_id: z.string().regex(/^diag-[0-9a-f-]{36}$/),
  run_id: z.string().min(1),
  worker_key: z.string().min(1),
  worker_generation: z.string().min(1),
  stage: workerDiagnosticStageSchema,
  error_code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  safe_summary: z.string().max(240),
  state: workerDiagnosticStateSchema,
  first_seen_at: z.string(),
  last_seen_at: z.string(),
  recovered_at: z.string().nullable(),
  retry_count: z.number().int().nonnegative(),
  retryable: z.boolean(),
  reconnect_required: z.boolean(),
}).strict();
export type WorkerDiagnostic = z.infer<typeof workerDiagnosticSchema>;
const stateSchema = z.object({ schema_version: z.literal(1), diagnostics: z.record(workerDiagnosticSchema) }).strict();
type DiagnosticState = z.infer<typeof stateSchema>;

export type WorkerDiagnosticInput = Omit<WorkerDiagnostic, "diagnostic_id" | "first_seen_at" | "last_seen_at" | "recovered_at" | "state"> & { state?: WorkerDiagnosticState; recovered_at?: string | null };

function pathFor(paths: ServicePaths): string { return join(paths.state, "worker-diagnostics.json"); }
function empty(): DiagnosticState { return { schema_version: 1, diagnostics: {} }; }
function safeCode(stage: WorkerDiagnosticStage, error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (stage === "socket_connect" && message.includes("timed out")) return "WORKER_SOCKET_TIMEOUT";
  if (stage === "socket_connect") return "WORKER_SOCKET_UNAVAILABLE";
  if (stage === "response_stream") return "WORKER_STREAM_FAILED";
  if (stage === "worker_stop") return "WORKER_STOP_FAILED";
  if (stage === "worker_select") return "RUN_WORKER_UNAVAILABLE";
  return "WORKER_REQUEST_FAILED";
}

export function workerDiagnosticFromError(input: Omit<WorkerDiagnosticInput, "error_code" | "safe_summary"> & { error?: unknown }): WorkerDiagnosticInput {
  const { error, ...safeInput } = input;
  const code = safeCode(input.stage, error);
  return { ...safeInput, error_code: code, safe_summary: "Viewer worker temporarily unavailable" };
}

export class WorkerDiagnosticStore {
  constructor(readonly paths: ServicePaths, private readonly now = () => new Date()) {}
  private read(): DiagnosticState {
    const path = pathFor(this.paths);
    if (!existsSync(path)) return empty();
    try { return stateSchema.parse(JSON.parse(readRegular(path).toString("utf8"))); }
    catch { return empty(); }
  }
  private transaction<T>(fn: (state: DiagnosticState) => T): T {
    return withExclusiveLock(join(this.paths.state, "lifecycle.lock"), () => {
      const state = this.read();
      const result = fn(state);
      writeAtomic(pathFor(this.paths), JSON.stringify(stateSchema.parse(state)) + "\n");
      return result;
    });
  }
  record(input: WorkerDiagnosticInput): WorkerDiagnostic {
    return this.transaction((state) => {
      const previous = state.diagnostics[input.run_id];
      const now = this.now().toISOString();
      const diagnostic = workerDiagnosticSchema.parse({
        ...input,
        diagnostic_id: previous?.diagnostic_id ?? `diag-${randomUUID()}`,
        first_seen_at: previous?.first_seen_at ?? now,
        last_seen_at: now,
        recovered_at: input.recovered_at ?? (previous?.state === "recovered" ? null : previous?.recovered_at ?? null),
        state: input.state ?? (previous ? "retrying" : "observed"),
      });
      state.diagnostics[input.run_id] = diagnostic;
      return diagnostic;
    });
  }
  recover(runId: string): WorkerDiagnostic | null {
    return this.transaction((state) => {
      const previous = state.diagnostics[runId];
      if (!previous) return null;
      const now = this.now().toISOString();
      const diagnostic = workerDiagnosticSchema.parse({ ...previous, state: "recovered", recovered_at: previous.recovered_at ?? now, last_seen_at: now });
      state.diagnostics[runId] = diagnostic;
      return diagnostic;
    });
  }
  get(runId: string): WorkerDiagnostic | null { return this.read().diagnostics[runId] ?? null; }
  sweep(now = this.now().getTime(), runExists: (runId: string) => boolean = () => true): number {
    return this.transaction((state) => {
      let removed = 0;
      for (const [runId, diagnostic] of Object.entries(state.diagnostics)) {
        if (!runExists(runId) || now - Date.parse(diagnostic.last_seen_at) > 7 * 24 * 60 * 60_000) { delete state.diagnostics[runId]; removed++; }
      }
      return removed;
    });
  }
}
