import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { readRegularNoFollow } from "./secure_io";

export const DEFAULT_STORE_NAME = "user-inline-assets";

export type RepoScope = {
  repoRoot: string;
  repoSlug: string;
  repoHash8: string;
  repoScope: string;
};

export function slugify(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

export function defaultCodexHome(): string {
  const configured = process.env.CODEX_HOME;
  if (configured) return resolve(expandUserPath(configured));
  const homeDefault = resolve(process.env.HOME ?? homedir(), ".codex");
  try {
    if (lstatSync(homeDefault).isDirectory()) return realpathSync(homeDefault);
  } catch {}
  return resolve(import.meta.dir, "../../..");
}

export function expandUserPath(path: string): string {
  const home = process.env.HOME?.trim() || homedir();
  return path.replace(/^~(?=$|[\\/])/, home);
}

export function defaultSnapshotRoot(): string {
  return join(defaultCodexHome(), DEFAULT_STORE_NAME);
}

export function gitStdout(cwd: string, ...args: string[]): string | null {
  try {
    const output = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

export function resolveRepoRoot(cwd: string): string {
  const reported = gitStdout(resolve(cwd), "rev-parse", "--show-toplevel");
  try {
    return realpathSync(reported ?? resolve(cwd));
  } catch {
    return resolve(reported ?? cwd);
  }
}

export function repoScope(cwd: string): RepoScope {
  const repoRoot = resolveRepoRoot(cwd);
  const repoSlug = slugify(basename(repoRoot), "repo");
  const repoHash8 = createHash("sha256")
    .update(repoRoot)
    .digest("hex")
    .slice(0, 8);
  return {
    repoRoot,
    repoSlug,
    repoHash8,
    repoScope: `${repoSlug}__${repoHash8}`,
  };
}

export function normalizedSuffix(path: string): string {
  const suffix = extname(path).normalize("NFKC").toLowerCase();
  if (!suffix)
    throw new Error(`source image must have a file extension: ${path}`);
  return `.${slugify(suffix.slice(1), "img")}`;
}

export function resolveExistingFile(source: string, cwd: string): string {
  const expanded = expandUserPath(source);
  const candidate = isAbsolute(expanded) ? expanded : join(cwd, expanded);
  try {
    const resolved = realpathSync(candidate);
    if (!isRegularFile(resolved))
      throw new Error(`source image is not a file: ${resolved}`);
    return resolved;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("source image is not a file")
    )
      throw error;
    throw new Error(`source image not found: ${candidate}`);
  }
}

export function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export function isIndependentRegularFile(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && metadata.nlink === 1;
  } catch {
    return false;
  }
}

export function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function pathWithin(root: string, target: string): boolean {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const delta = relative(rootPath, targetPath);
  return (
    delta === "" ||
    (delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta))
  );
}

export function containedPathWithoutSymlinks(
  path: string,
  root: string,
): string | null {
  const rootPath = resolve(root);
  const rawAbsolute = isAbsolute(path)
    ? path
    : `${process.cwd().replace(/[\\/]+$/, "")}${sep}${path}`;
  const targetPath = resolve(rawAbsolute);
  if (!pathWithin(rootPath, targetPath)) return null;
  const parts = rawAbsolute.split(sep).slice(1);
  let current: string = sep;
  const hasRemainingComponent = (start: number): boolean =>
    parts.slice(start).some((part) => part !== "" && part !== ".");
  for (const [index, part] of parts.entries()) {
    if (!part || part === ".") continue;
    if (part === "..") {
      current = current === sep ? sep : join(current, "..");
      continue;
    }
    const component = join(current, part);
    const insideRoot =
      current === rootPath ||
      pathWithin(rootPath, current) ||
      component === rootPath;
    if (insideRoot) {
      try {
        const metadata = lstatSync(component);
        if (metadata.isSymbolicLink()) return null;
        if (!metadata.isDirectory() && hasRemainingComponent(index + 1))
          return null;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" ||
          hasRemainingComponent(index + 1)
        )
          return null;
      }
    }
    current = component;
  }
  try {
    if (!pathWithin(realpathSync(rootPath), realpathSync(rawAbsolute)))
      return null;
  } catch {
    return null;
  }
  return targetPath;
}

export function isReadableRegularFile(path: string): string | null {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile()) return "snapshot_not_file";
    if ((metadata.mode & 0o444) === 0) return "snapshot_not_readable";
    accessSync(path, constants.R_OK);
    const descriptor = openSync(path, "r");
    try {
      readSync(descriptor, Buffer.alloc(1), 0, 1, 0);
    } finally {
      closeSync(descriptor);
    }
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "snapshot_missing"
      : "snapshot_not_readable";
  }
}

export function sha256FileSync(path: string): string {
  const hash = createHash("sha256");
  readRegularNoFollow(path, undefined, (chunk) => hash.update(chunk));
  return hash.digest("hex");
}

export function formatUtcTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export function ensureDirectory(path: string): void {
  ensureDirectoryWithin(path, path);
}

export function isPlatformPathAlias(path: string): boolean {
  return (
    process.platform === "darwin" && ["/etc", "/tmp", "/var"].includes(path)
  );
}

function ensureDirectoryComponent(path: string): void {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
      throw new Error(`directory component is unsafe: ${path}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    mkdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new Error(`directory component is unsafe: ${path}`);
}

function ensureRootDirectory(path: string): string {
  const requested = resolve(path);
  const parts = requested.split(sep).filter(Boolean);
  let current: string = sep;
  for (const [index, part] of parts.entries()) {
    const requestedComponent = join(sep, ...parts.slice(0, index + 1));
    const component = join(current, part);
    try {
      const metadata = lstatSync(component);
      if (metadata.isSymbolicLink()) {
        if (!isPlatformPathAlias(requestedComponent))
          throw new Error(
            `directory component is unsafe: ${requestedComponent}`,
          );
        current = realpathSync(component);
      } else if (metadata.isDirectory()) current = component;
      else
        throw new Error(`directory component is unsafe: ${requestedComponent}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ensureDirectoryComponent(component);
      current = component;
    }
  }
  return current;
}

export function ensureDirectoryWithin(path: string, root: string): string {
  const requestedRoot = resolve(root);
  const requestedTarget = resolve(path);
  if (!pathWithin(requestedRoot, requestedTarget))
    throw new Error(`directory escapes trusted root: ${requestedTarget}`);
  const canonicalRoot = ensureRootDirectory(requestedRoot);
  let current = canonicalRoot;
  for (const part of relative(requestedRoot, requestedTarget)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, part);
    ensureDirectoryComponent(current);
  }
  return current;
}
