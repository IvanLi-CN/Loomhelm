import { existsSync } from "node:fs";
import { join } from "node:path";
import { tryLockFile } from "../../../skills/bin/modules/core/security_file";
import { writeAtomic, readRegular } from "../lib/store";
import type { ServiceState } from "../lib/service-state";

const CACHE_TTL_MS = 6 * 60 * 60_000;
const CHECK_TIMEOUT_MS = 1500;
const cachePath = (state: ServiceState) => join(state.paths.state, "daemon-update.json");
type Cache = {
  checked_at: string;
  compatible_version: string | null;
  latest_version: string | null;
};
export type DaemonUpdateHint = {
  kind: "daemon_update";
  message: "A newer Dashboard daemon is available";
  compatible_version?: string;
  latest_version?: string;
};

function readCache(state: ServiceState): Cache | null {
  try {
    if (!existsSync(cachePath(state))) return null;
    const value = JSON.parse(readRegular(cachePath(state))) as Cache;
    if (typeof value.checked_at !== "string" || (value.compatible_version !== null && typeof value.compatible_version !== "string") || (value.latest_version !== null && typeof value.latest_version !== "string")) return null;
    return value;
  } catch { return null; }
}

export function cachedDaemonUpdate(state: ServiceState): DaemonUpdateHint | undefined {
  const config = state.config();
  const cache = readCache(state);
  if (!cache || !config.package_version || Date.now() - Date.parse(cache.checked_at) > CACHE_TTL_MS) return undefined;
  const compatible = cache.compatible_version && cache.compatible_version !== config.package_version ? cache.compatible_version : undefined;
  const latest = cache.latest_version && cache.latest_version !== config.package_version && cache.latest_version !== compatible ? cache.latest_version : undefined;
  if (!compatible && !latest) return undefined;
  return { kind: "daemon_update", message: "A newer Dashboard daemon is available", ...(compatible ? { compatible_version: compatible } : {}), ...(latest ? { latest_version: latest } : {}) };
}

export function triggerDaemonUpdateCheck(state: ServiceState): void {
  const config = state.config();
  if (!config.package_name || !config.package_version) return;
  const existing = readCache(state);
  if (existing && Date.now() - Date.parse(existing.checked_at) <= CACHE_TTL_MS) return;
  let lock: { release(): void } | undefined;
  try { lock = tryLockFile(join(state.paths.state, "daemon-update.lock")); } catch { return; }
  if (!lock) return;
  void (async () => {
    try {
      const response = await fetch("https://registry.npmjs.org/%40loomhelm%2Fmulti-task-flow", { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      if (!response.ok) return;
      const metadata = await response.json() as { "dist-tags"?: Record<string, unknown> };
      const tags = metadata["dist-tags"] ?? {};
      const compatible = typeof tags[config.compatibility_line ?? ""] === "string" ? tags[config.compatibility_line ?? ""] as string : null;
      const latest = typeof tags.latest === "string" ? tags.latest : null;
      writeAtomic(cachePath(state), JSON.stringify({ checked_at: new Date().toISOString(), compatible_version: compatible, latest_version: latest }) + "\n");
    } catch { /* Update discovery is an optional side channel. */ }
    finally { lock?.release(); }
  })();
}

