import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readRegularNoFollow } from "@loomhelm/runtime-core/modules/visual/secure_io";
import { z } from "zod";
import { ContractError, requireCondition } from "./errors";
import type { ServiceState } from "./service-state";
import { safeId, withExclusiveLock, writeAtomic } from "./store";

export const viewerBindingSchema = z
  .object({
    schema_version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    run_id: z.string().min(1),
    package_name: z.literal("@loomhelm/multi-task-flow"),
    package_version: z.union([
      z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
      z.literal("source-preview"),
    ]),
    build_id: z.string().regex(/^[a-f0-9]{64}$/),
    source_sha: z.string().regex(/^[a-f0-9]{40}$/),
    compatibility_line: z.string().regex(/^compat-v\d+$/),
    ledger_contract: z.number().int().positive(),
    api_contract: z.number().int().positive(),
    frontend_contract: z.number().int().positive(),
    viewer_contract: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    request_id: z.string().min(1),
    updated_at: z.string().datetime(),
  })
  .strict();
export type ViewerBinding = z.infer<typeof viewerBindingSchema>;

export function viewerBindingPath(state: ServiceState, runId: string): string {
  safeId(runId);
  return join(state.paths.data, "runs", runId, "runtime", "viewer-binding.json");
}

function bindingLockPath(state: ServiceState, runId: string): string {
  return join(state.paths.data, "runs", safeId(runId), "locks", "viewer-binding.lock");
}

export function readViewerBinding(state: ServiceState, runId: string): ViewerBinding | null {
  const expectedRunId = safeId(runId);
  const path = viewerBindingPath(state, expectedRunId);
  if (!existsSync(path)) return null;
  try {
    const binding = viewerBindingSchema.parse(
      JSON.parse(readRegularNoFollow(path, state.paths.root).toString("utf8")),
    );
    if (binding.run_id !== expectedRunId) throw new Error("viewer binding run identity mismatch");
    return binding;
  } catch {
    throw new ContractError("VIEWER_BINDING_INVALID", "Run version binding is invalid", 2);
  }
}

export type ViewerBindingIdentity = Omit<ViewerBinding, "revision" | "request_id" | "updated_at">;
export function ensureViewerBinding(
  state: ServiceState,
  runId: string,
  _fallback?: Partial<ViewerBindingIdentity>,
): ViewerBinding {
  const existing = readViewerBinding(state, runId);
  requireCondition(
    existing !== null,
    "SOURCE_IDENTITY_UNAVAILABLE",
    "Historical run identity is missing; current Gateway identity cannot establish its source",
    4,
  );
  return existing!;
}

export function writeViewerBinding(
  state: ServiceState,
  binding: ViewerBinding,
  expected?: { revision: number; source_sha: string },
): ViewerBinding {
  viewerBindingSchema.parse(binding);
  const path = viewerBindingPath(state, binding.run_id);
  return withExclusiveLock(bindingLockPath(state, binding.run_id), () => {
    const previous = readViewerBinding(state, binding.run_id);
    requireCondition(
      (!previous || previous.schema_version === 1) && binding.schema_version === 1,
      "UPGRADE_REQUIRED",
      "Versioned binding changes require the explicit forward upgrade transaction",
      4,
    );
    if (
      expected &&
      (!previous ||
        previous.revision !== expected.revision ||
        previous.source_sha !== expected.source_sha)
    )
      throw new ContractError(
        "VIEWER_BINDING_CONFLICT",
        "Run version binding changed during upgrade",
        2,
      );
    const next = viewerBindingSchema.parse({
      ...binding,
      revision: previous ? previous.revision + 1 : binding.revision,
      updated_at: new Date().toISOString(),
    });
    mkdirSync(join(state.paths.data, "runs", binding.run_id, "runtime"), {
      recursive: true,
      mode: 0o700,
    });
    writeAtomic(path, JSON.stringify(next) + "\n");
    return next;
  });
}
