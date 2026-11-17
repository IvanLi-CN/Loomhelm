import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createDirectoryNoFollow,
  readRegularNoFollow,
  renameNoReplace,
  syncDirectoryNoFollow,
  writeAtomicNoFollow,
  writeExclusiveNoFollow,
} from "@loomhelm/runtime-core/modules/visual/secure_io";
import { z } from "zod";
import { runIdentity } from "./orchestration-identity";
import type { LedgerStore } from "./store";
export const uuid = z.string().uuid();
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const markerSchema = z
  .object({
    invocation_id: uuid,
    identity: runIdentity,
    state: z.enum(["running", "stopped"]),
    schema_version: z.literal(2).optional(),
  })
  .strict();
const eventBase = { schema_version: z.literal(1), invocation_id: uuid };
export const startSchema = z
  .object({
    ...eventBase,
    type: z.literal("start"),
    command: z.string().min(1),
    input_digest: hash,
    identity: runIdentity,
    run_id: z.string(),
    revision: z.number().int().nonnegative(),
    actor: z.unknown(),
    process: z.object({
      pid: z.number().int().positive(),
      supervision_token: z.string().nullable(),
    }),
    at: z.string().datetime(),
  })
  .strict();
export const resourceSchema = z
  .object({
    ...eventBase,
    type: z.literal("resource_intent"),
    resource_id: uuid,
    kind: z.string().min(1),
    reference: z.unknown(),
    at: z.string().datetime(),
  })
  .strict();
export const terminalSchema = z
  .object({
    ...eventBase,
    type: z.literal("resource_terminal"),
    resource_id: uuid,
    intent_digest: hash,
    evidence: z.record(z.string(), z.unknown()),
  })
  .strict();
export const finishedSchema = z
  .object({
    ...eventBase,
    type: z.literal("execution_finished"),
    start_digest: hash,
    outcome: z.enum(["succeeded", "failed"]),
    output_delivery: z.literal("unobserved"),
    at: z.string().datetime(),
  })
  .strict();

export function digest(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, value]) => [key, canonical(value)]),
          )
        : item;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function markerPath(store: LedgerStore): string {
  return join(store.runPath, "runtime", "call.json");
}
export function readMarker(store: LedgerStore) {
  const path = markerPath(store);
  return existsSync(path)
    ? markerSchema.parse(JSON.parse(readRegularNoFollow(path, store.rootPath).toString("utf8")))
    : null;
}
export function directory(store: LedgerStore, id: string): string {
  return join(store.runPath, "runtime", "invocations", uuid.parse(id));
}
export function readEvent(store: LedgerStore, id: string, name: string): any {
  const path = join(directory(store, id), name + ".json");
  return existsSync(path)
    ? JSON.parse(readRegularNoFollow(path, store.rootPath).toString("utf8"))
    : null;
}
/** Sync privately before publishing an immutable event name. No event is overwritten. */
export function append(store: LedgerStore, id: string, name: string, value: object): void {
  const dir = directory(store, id);
  for (const path of [
    join(store.runPath, "runtime"),
    join(store.runPath, "runtime", "invocations"),
    dir,
  ]) {
    if (!existsSync(path)) {
      createDirectoryNoFollow(path, store.rootPath);
      syncDirectoryNoFollow(join(path, ".."), store.rootPath);
    }
  }
  const staged = join(dir, ".event-" + randomUUID());
  writeExclusiveNoFollow(
    staged,
    JSON.stringify({ schema_version: 1, invocation_id: id, ...value }),
    store.rootPath,
  );
  renameNoReplace(staged, join(dir, name + ".json"), store.rootPath);
  syncDirectoryNoFollow(dir, store.rootPath);
}
