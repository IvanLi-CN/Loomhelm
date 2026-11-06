import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { resolve, sep } from "node:path";

export function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId))
    throw new Error("baseline run id contains unsafe path characters");
}

export function pathUnderRoot(root: string, file: string): string {
  const base = resolve(root);
  const target = resolve(base, file);
  if (target !== base && !target.startsWith(`${base}${sep}`))
    throw new Error("baseline log path escapes its run directory");
  return target;
}

export function assertSafeDirectory(path: string): string {
  const absolute = resolve(path);
  let descriptor = -1;
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink())
      throw new Error("baseline root cannot be a symlink");
    if (!stat.isDirectory())
      throw new Error("baseline root is not a directory");
    descriptor = openSync(
      absolute,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const canonical = realpathSync.native(absolute);
    const opened = fstatSync(descriptor);
    const resolved = statSync(canonical);
    if (opened.dev !== resolved.dev || opened.ino !== resolved.ino)
      throw new Error("baseline root changed");
    return canonical;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("baseline root"))
      throw error;
    throw new Error("baseline root is unavailable");
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}
