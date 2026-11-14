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
  package_name: string;
  compatibility_line: string;
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
    if (typeof value.checked_at !== "string" || !Number.isFinite(Date.parse(value.checked_at)) || typeof value.package_name !== "string" || typeof value.compatibility_line !== "string" || (value.compatible_version !== null && typeof value.compatible_version !== "string") || (value.latest_version !== null && typeof value.latest_version !== "string")) return null;
    return value;
  } catch { return null; }
}

export function cachedDaemonUpdate(state: ServiceState): DaemonUpdateHint | undefined {
  const config = state.config();
  const cache = readCache(state);
  if (!cache || !config.package_name || !config.package_version || cache.package_name !== config.package_name || cache.compatibility_line !== config.compatibility_line || Date.now() - Date.parse(cache.checked_at) > CACHE_TTL_MS) return undefined;
  const newer = (candidate: string | null) => Boolean(candidate && compareSemver(candidate, config.package_version!) > 0);
  const compatible = newer(cache.compatible_version) ? cache.compatible_version! : undefined;
  const latest = newer(cache.latest_version) && cache.latest_version !== compatible ? cache.latest_version! : undefined;
  if (!compatible && !latest) return undefined;
  return { kind: "daemon_update", message: "A newer Dashboard daemon is available", ...(compatible ? { compatible_version: compatible } : {}), ...(latest ? { latest_version: latest } : {}) };
}

function compareSemver(left: string, right: string): number {
  const parse = (value: string) => value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  const a = parse(left); const b = parse(right);
  if (!a || !b) return -1;
  for (const index of [1, 2, 3]) { const delta = Number(a[index]) - Number(b[index]); if (delta) return delta; }
  if (!a[4] && b[4]) return 1;
  if (a[4] && !b[4]) return -1;
  if (!a[4] || !b[4]) return 0;
  const leftParts = a[4].split("."); const rightParts = b[4].split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const l = leftParts[index]; const r = rightParts[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const lNumeric = /^\d+$/.test(l); const rNumeric = /^\d+$/.test(r);
    if (lNumeric && rNumeric) return Number(l) - Number(r);
    if (lNumeric !== rNumeric) return lNumeric ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export function triggerDaemonUpdateCheck(state: ServiceState): void {
  const config = state.config();
  if (!config.package_name || !config.package_version) return;
  const existing = readCache(state);
  if (existing && existing.package_name === config.package_name && existing.compatibility_line === (config.compatibility_line ?? "") && Date.now() - Date.parse(existing.checked_at) <= CACHE_TTL_MS) return;
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
      writeAtomic(cachePath(state), JSON.stringify({ checked_at: new Date().toISOString(), package_name: config.package_name, compatibility_line: config.compatibility_line ?? "", compatible_version: compatible, latest_version: latest }) + "\n");
    } catch { /* Update discovery is an optional side channel. */ }
    finally { lock?.release(); }
  })();
}

