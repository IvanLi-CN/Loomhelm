import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import {
  defaultSnapshotRoot,
  ensureDirectoryWithin,
  expandUserPath,
  formatUtcTimestamp,
  normalizedSuffix,
  repoScope,
  resolveExistingFile,
  slugify,
} from "./paths";
import { copyFileExclusiveNoFollow } from "./secure_io";

export type SnapshotOptions = {
  source: string;
  cwd: string;
  now?: Date;
  rand8?: string;
  storeRoot?: string;
};

export type SnapshotResult = {
  snapshot_path: string;
  source_path: string;
  store_root: string;
  repo_root: string;
  repo_scope: string;
  repo_slug: string;
  repo_hash8: string;
  created_at_utc: string;
};

export function createSnapshot(options: SnapshotOptions): SnapshotResult {
  const cwd = resolve(expandUserPath(options.cwd));
  const sourcePath = resolveExistingFile(options.source, cwd);
  const scope = repoScope(cwd);
  const suffix = normalizedSuffix(sourcePath);
  const sourceStem = slugify(
    sourcePath
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]*$/, "") ?? "",
    "image",
  );
  const timestamp = formatUtcTimestamp(options.now ?? new Date());
  const date = timestamp.slice(0, 8);
  const requestedStoreRoot = resolve(
    expandUserPath(options.storeRoot ?? defaultSnapshotRoot()),
  );
  const requestedTargetDirectory = join(
    requestedStoreRoot,
    scope.repoScope,
    date.slice(0, 4),
    date.slice(4, 6),
    date.slice(6, 8),
  );
  const storeRoot = ensureDirectoryWithin(
    requestedStoreRoot,
    requestedStoreRoot,
  );
  const targetDirectory = ensureDirectoryWithin(
    requestedTargetDirectory,
    requestedStoreRoot,
  );

  while (true) {
    const token = options.rand8 ?? randomBytes(4).toString("hex");
    if (!/^[a-f0-9]{8}$/.test(token))
      throw new Error(
        "snapshot token must be eight lowercase hexadecimal characters",
      );
    const candidate = join(
      targetDirectory,
      `${timestamp}-${sourceStem}-${token}${suffix}`,
    );
    try {
      copyFileExclusiveNoFollow(sourcePath, candidate, storeRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (options.rand8)
        throw new Error(`snapshot path already exists: ${candidate}`);
      continue;
    }
    return {
      snapshot_path: candidate,
      source_path: sourcePath,
      store_root: storeRoot,
      repo_root: scope.repoRoot,
      repo_scope: scope.repoScope,
      repo_slug: scope.repoSlug,
      repo_hash8: scope.repoHash8,
      created_at_utc: timestamp,
    };
  }
}

export function snapshotMain(argv: string[] = process.argv.slice(2)): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: bun snapshot_local_image.ts --source <path> --cwd <path>",
    );
    return 0;
  }
  const values = new Map<string, string>();
  let pretty = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--pretty") {
      pretty = true;
      continue;
    }
    if (value?.startsWith("--") && next) {
      values.set(value.slice(2), next);
      index += 1;
    }
  }
  try {
    const result = createSnapshot({
      source: values.get("source") ?? "",
      cwd: values.get("cwd") ?? "",
    });
    process.stdout.write(
      `${JSON.stringify(result, null, pretty ? 2 : undefined)}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
