import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { requireCondition } from "./errors";

export const UPGRADE_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;

export type UpgradeSnapshotBudget = {
  entries: number;
  bytes: number;
  max_bytes: number;
  within_byte_budget: boolean;
};

type SnapshotFile = {
  path: string;
  relative_path: string;
  metadata: ReturnType<typeof lstatSync>;
  parent_identity: { dev: number; ino: number };
};

type SnapshotCallbacks = {
  onDirectory?: (relativePath: string) => void;
  onDirectoryComplete?: (relativePath: string) => void;
  onFile?: (file: SnapshotFile, budget: UpgradeSnapshotBudget) => void;
};

function sameDirectory(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isWithin(root: string, target: string): boolean {
  const delta = relative(resolve(root), resolve(target));
  return (
    delta === "" || (delta !== ".." && !delta.startsWith(`..${sep}`) && !delta.startsWith(sep))
  );
}

function requireDirectory(
  path: string,
  root: string,
  message: string,
): { dev: number; ino: number } {
  requireCondition(isWithin(root, path), "UNSAFE_PATH", message, 5);
  const metadata = lstatSync(path);
  requireCondition(
    metadata.isDirectory() && !metadata.isSymbolicLink() && realpathSync(path) === path,
    "UNSAFE_PATH",
    message,
    5,
  );
  return { dev: metadata.dev, ino: metadata.ino };
}

/** Walk a private run snapshot once so dry-run and publication enforce the same byte budget. */
export function walkUpgradeSnapshot(
  source: string,
  root: string,
  callbacks: SnapshotCallbacks = {},
): UpgradeSnapshotBudget {
  const sourcePath = resolve(source);
  requireDirectory(sourcePath, root, "Upgrade source directory must not traverse symlinks");
  const budget: UpgradeSnapshotBudget = {
    entries: 0,
    bytes: 0,
    max_bytes: UPGRADE_SNAPSHOT_MAX_BYTES,
    within_byte_budget: true,
  };

  const visit = (directory: string, relativePath: string): void => {
    const directoryIdentity = requireDirectory(
      directory,
      root,
      "Upgrade source directory must not traverse symlinks",
    );
    callbacks.onDirectory?.(relativePath);
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const metadata = lstatSync(path);
      const childRelativePath = relative(sourcePath, path);
      budget.entries += 1;
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        visit(path, childRelativePath);
        continue;
      }
      requireCondition(
        metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1,
        "UNSAFE_PATH",
        "Upgrade snapshots accept only private regular files and directories",
        5,
      );
      budget.bytes += metadata.size;
      budget.within_byte_budget = budget.bytes <= UPGRADE_SNAPSHOT_MAX_BYTES;
      callbacks.onFile?.(
        {
          path,
          relative_path: childRelativePath,
          metadata,
          parent_identity: directoryIdentity,
        },
        budget,
      );
    }
    requireCondition(
      sameDirectory(lstatSync(directory), directoryIdentity),
      "UNSAFE_PATH",
      "Upgrade source directory changed",
      5,
    );
    callbacks.onDirectoryComplete?.(relativePath);
  };

  visit(sourcePath, "");
  return budget;
}

export function inspectUpgradeSnapshot(source: string, root: string): UpgradeSnapshotBudget {
  return walkUpgradeSnapshot(source, root);
}
