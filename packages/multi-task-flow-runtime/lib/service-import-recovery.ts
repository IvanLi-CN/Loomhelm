import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { renameNoReplace } from "../../../skills/bin/modules/visual/secure_io";
import {
  readRegular,
  syncDirectory,
  withExclusiveLock,
  writeAtomic,
} from "../lib/store";
import { requireCondition } from "../lib/errors";
import type { ServiceState } from "../lib/service-state";

const journalSchema = z
  .object({
    source: z.string(),
    target: z.string(),
    backup: z.string(),
    staging: z.string(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    phase: z.enum(["prepared", "completed"]),
  })
  .strict();

export function recoverImport(
  state: ServiceState,
  sourceRoot: string,
  runId: string,
  digest: (root: string) => string,
): string | null {
  const source = join(sourceRoot, "runs", runId);
  const target = join(state.paths.data, "runs", runId);
  const candidates = readdirSync(state.paths.state).filter((name) =>
    /^import-[a-f0-9-]+\.json$/.test(name),
  );
  for (const name of candidates) {
    const journal = journalSchema.parse(
      JSON.parse(readRegular(join(state.paths.state, name))),
    );
    if (
      journal.source !== source ||
      journal.target !== target ||
      journal.phase !== "prepared"
    )
      continue;
    const operation = name.slice(7, -5);
    requireCondition(
      journal.backup ===
        join(sourceRoot, "runs", `.migrated-${runId}-${operation}`) &&
        journal.staging ===
          join(state.paths.data, "runs", `.import-${operation}`),
      "UNSAFE_IMPORT_JOURNAL",
      "Migration journal paths do not match operation identity",
    );
    // A prepared journal before the rename is safe to retry through the normal lock.
    if (!existsSync(journal.backup)) return null;
    return withExclusiveLock(
      join(state.paths.data, ".maintenance.lock"),
      () => {
        requireCondition(
          digest(journal.backup) === journal.digest,
          "IMPORT_RECOVERY_FAILED",
          "Migration backup changed; explicit inspection required",
        );
        if (existsSync(source))
          requireCondition(
            existsSync(join(source, "migrated.json")),
            "IMPORT_CONFLICT",
            "Source has been recreated; refusing migration recovery",
          );
        else mkdirSync(source, { mode: 0o700 });
        writeAtomic(
          join(source, "migrated.json"),
          JSON.stringify({
            target,
            backup: journal.backup,
            digest: journal.digest,
            operation,
          }),
        );
        if (!existsSync(target)) {
          requireCondition(
            digest(journal.staging) === journal.digest,
            "IMPORT_RECOVERY_FAILED",
            "Migration staging changed; explicit inspection required",
          );
          renameNoReplace(journal.staging, target, state.paths.data);
          syncDirectory(join(state.paths.data, "runs"));
        } else
          requireCondition(
            digest(target) === journal.digest,
            "IMPORT_CONFLICT",
            "Destination changed during interrupted migration; refusing overwrite",
          );
        writeAtomic(
          join(state.paths.state, name),
          JSON.stringify({ ...journal, phase: "completed" }),
        );
        return journal.backup;
      },
    );
  }
  return null;
}
