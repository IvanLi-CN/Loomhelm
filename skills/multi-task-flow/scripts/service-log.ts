import {
  existsSync,
  lstatSync,
  renameSync,
  writeSync,
  openSync,
  closeSync,
  constants,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { ensureDirectory, withExclusiveLock } from "./store";
import type { ServicePaths } from "./service-paths";

export function serviceLog(
  paths: ServicePaths,
  event:
    | "started"
    | "stopped"
    | "stopping"
    | "startup_failed"
    | "lease_failed"
    | "maintenance_failed"
    | "maintenance_recovered",
  generation: string,
  buildId: string,
  details: Record<string, unknown> = {},
): void {
  ensureDirectory(paths.logs);
  withExclusiveLock(join(paths.logs, "log.lock"), () => {
    const path = join(paths.logs, "viewer.jsonl");
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Unsafe viewer log");
      if (stat.size >= 5 * 1024 * 1024) {
        const oldest = path + ".2";
        if (existsSync(oldest)) {
          const old = lstatSync(oldest);
          if (!old.isFile() || old.isSymbolicLink())
            throw new Error("Unsafe rotated log");
          unlinkSync(oldest);
        }
        if (existsSync(path + ".1")) renameSync(path + ".1", oldest);
        renameSync(path, path + ".1");
      }
    }
    // Only fixed event names and internal identities enter this log.
    const fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(
        fd,
        JSON.stringify({
          at: new Date().toISOString(),
          event,
          pid: process.pid,
          generation,
          build_id: buildId,
          ...details,
        }) + "\n",
      );
    } finally {
      closeSync(fd);
    }
  });
}
