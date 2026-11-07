import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ensureDirectory,
  readRegular,
  withExclusiveLock,
  writeAtomic,
} from "./store";
import {
  configSchema,
  BROWSER_TTL_MS,
  type ServiceConfig,
} from "./service-contract";
import { requireCondition } from "./errors";
import type { ServicePaths } from "./service-paths";
import { readRegularNoFollow } from "../../bin/modules/visual/secure_io";

const leaseSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["agent", "browser"]),
    expires_at: z.number().finite(),
    run_id: z.string().nullable(),
    thread_id: z.string().nullable(),
  })
  .strict();
export type UsageLease = z.infer<typeof leaseSchema>;
export const runtimeSchema = z
  .object({
    schema_version: z.literal(1),
    generation: z.string().nullable(),
    pid: z.number().int().nullable(),
    phase: z.enum(["stopped", "starting", "running", "stopping"]),
    leases: z.array(leaseSchema),
  })
  .strict();
export type RuntimeState = z.infer<typeof runtimeSchema>;
export const emptyRuntime = (): RuntimeState => ({
  schema_version: 1,
  generation: null,
  pid: null,
  phase: "stopped",
  leases: [],
});

export class ServiceState {
  constructor(readonly paths: ServicePaths) {}
  initialize(): void {
    for (const path of [
      this.paths.config,
      this.paths.state,
      this.paths.logs,
      this.paths.releases,
      this.paths.data,
    ])
      ensureDirectory(path);
  }
  read<T>(path: string, schema: z.ZodType<T>): T {
    return schema.parse(
      JSON.parse(readRegularNoFollow(path, this.paths.root).toString("utf8")),
    );
  }
  config(): ServiceConfig {
    return this.read(join(this.paths.config, "service.json"), configSchema);
  }
  saveConfig(config: ServiceConfig): void {
    writeAtomic(
      join(this.paths.config, "service.json"),
      JSON.stringify(configSchema.parse(config)) + "\n",
    );
  }
  runtime(): RuntimeState {
    const path = join(this.paths.state, "runtime.json");
    return existsSync(path) ? this.read(path, runtimeSchema) : emptyRuntime();
  }
  transaction<T>(fn: (state: RuntimeState) => T): T {
    this.initialize();
    return withExclusiveLock(join(this.paths.state, "lifecycle.lock"), () => {
      const state = this.runtime();
      const previous = JSON.stringify(state);
      const result = fn(state);
      const next = JSON.stringify(runtimeSchema.parse(state));
      if (
        next !== previous ||
        !existsSync(join(this.paths.state, "runtime.json"))
      )
        writeAtomic(join(this.paths.state, "runtime.json"), next + "\n");
      return result;
    });
  }
  renew(
    lease: Omit<UsageLease, "expires_at">,
    ttl: number,
    now = Date.now(),
  ): UsageLease {
    requireCondition(
      Number.isFinite(ttl) && ttl > 0 && ttl <= 24 * 60 * 60_000,
      "INVALID_TTL",
      "Invalid lease TTL",
    );
    return this.transaction((state) => {
      requireCondition(
        state.phase !== "stopping",
        "SERVICE_STOPPING",
        "Viewer is stopping; call ensure again",
      );
      const current = { ...lease, expires_at: now + ttl };
      state.leases = state.leases.filter(
        (item) => item.expires_at > now && item.id !== lease.id,
      );
      state.leases.push(current);
      return current;
    });
  }
  renewBrowser(session: string, now = Date.now()): UsageLease {
    return this.renew(
      {
        id: "browser:" + session,
        kind: "browser",
        run_id: null,
        thread_id: null,
      },
      BROWSER_TTL_MS,
      now,
    );
  }
  release(id: string): void {
    this.transaction((state) => {
      state.leases = state.leases.filter((item) => item.id !== id);
    });
  }
  expire(generation: string, now = Date.now()): boolean {
    return this.transaction((state) => {
      requireCondition(
        state.generation === generation && state.pid === process.pid,
        "INSTANCE_REPLACED",
        "Viewer instance has been replaced",
      );
      state.leases = state.leases.filter((item) => item.expires_at > now);
      if (state.leases.length) return false;
      state.phase = "stopping";
      return true;
    });
  }
  stopped(generation: string): void {
    this.transaction((state) => {
      if (state.generation !== generation || state.pid !== process.pid) return;
      state.phase = "stopped";
      state.pid = null;
    });
  }
}
