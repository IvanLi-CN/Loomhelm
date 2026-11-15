import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readRegularNoFollow } from "@loomhelm/runtime-core/modules/visual/secure_io";
import { z } from "zod";
import { ContractError, requireCondition } from "./errors";
import type { ServiceState } from "./service-state";
import { LedgerStore, safeId, withExclusiveLock, writeAtomic } from "./store";

export const viewerBindingSchema = z
  .object({
    schema_version: z.literal(1),
    run_id: z.string().min(1),
    package_name: z.string().min(1),
    package_version: z.string().min(1),
    build_id: z.string().min(1),
    source_sha: z.string().min(1),
    compatibility_line: z.string().min(1),
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
  const path = viewerBindingPath(state, runId);
  if (!existsSync(path)) return null;
  try {
    return viewerBindingSchema.parse(
      JSON.parse(readRegularNoFollow(path, state.paths.root).toString("utf8")),
    );
  } catch {
    throw new ContractError("VIEWER_BINDING_INVALID", "Run version binding is invalid", 2);
  }
}

export type ViewerBindingIdentity = Omit<ViewerBinding, "revision" | "request_id" | "updated_at">;
function identityFromConfig(
  state: ServiceState,
  runId: string,
  fallback?: Partial<ViewerBindingIdentity>,
): ViewerBindingIdentity {
  const config = (() => {
    try {
      return state.config();
    } catch {
      return {} as any;
    }
  })();
  const packageName = config.package_name ?? fallback?.package_name;
  const packageVersion = config.package_version ?? fallback?.package_version;
  const buildId = config.current_build || fallback?.build_id;
  const sourceSha = config.source_sha ?? fallback?.source_sha;
  const compatibilityLine = config.compatibility_line ?? fallback?.compatibility_line;
  requireCondition(
    Boolean(packageName && packageVersion && buildId && sourceSha && compatibilityLine),
    "VIEWER_BINDING_IDENTITY_UNAVAILABLE",
    "Verified Gateway package identity is unavailable",
    2,
  );
  return {
    schema_version: 1,
    run_id: safeId(runId),
    package_name: packageName!,
    package_version: packageVersion!,
    build_id: buildId!,
    source_sha: sourceSha!,
    compatibility_line: compatibilityLine!,
    ledger_contract: config.ledger_contract ?? fallback?.ledger_contract ?? 3,
    api_contract: config.api_contract ?? fallback?.api_contract ?? 1,
    frontend_contract: config.frontend_contract ?? fallback?.frontend_contract ?? 1,
    viewer_contract: config.viewer_contract ?? fallback?.viewer_contract ?? 5,
  };
}

export function ensureViewerBinding(
  state: ServiceState,
  runId: string,
  fallback?: Partial<ViewerBindingIdentity>,
): ViewerBinding {
  const existing = readViewerBinding(state, runId);
  if (existing) return existing;
  const store = new LedgerStore(state.paths.data, safeId(runId));
  store.read();
  const path = viewerBindingPath(state, runId);
  return withExclusiveLock(bindingLockPath(state, runId), () => {
    const current = readViewerBinding(state, runId);
    if (current) return current;
    const identity = identityFromConfig(state, runId, fallback);
    const binding = viewerBindingSchema.parse({
      ...identity,
      revision: 0,
      request_id: `bootstrap-${randomUUID()}`,
      updated_at: new Date().toISOString(),
    });
    mkdirSync(join(state.paths.data, "runs", runId, "runtime"), { recursive: true, mode: 0o700 });
    writeAtomic(path, JSON.stringify(binding) + "\n");
    return binding;
  });
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
