import { dlopen, FFIType } from "bun:ffi";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  createDirectoryNoFollow,
  type DirectoryIdentity,
  readRegularNoFollow,
  syncDirectoryNoFollow,
  writeAtomicNoFollow,
  writeExclusiveNoFollow,
} from "@loomhelm/runtime-core/modules/visual/secure_io";
import { requireCondition } from "./errors";

function same(a: DirectoryIdentity, b: DirectoryIdentity) {
  return a.dev === b.dev && a.ino === b.ino;
}
/** Retain a private source snapshot; never follow links or copy live sockets into a candidate. */
function cloneDirectory(
  source: string,
  destination: string,
  root: string,
  budget = { bytes: 0, entries: 0 },
): void {
  const sourceIdentity = lstatSync(source);
  requireCondition(
    sourceIdentity.isDirectory() &&
      !sourceIdentity.isSymbolicLink() &&
      realpathSync(source) === source,
    "UNSAFE_PATH",
    "Upgrade source directory must not traverse symlinks",
    5,
  );
  createDirectoryNoFollow(destination, root);
  const destinationIdentity = lstatSync(destination);
  for (const entry of readdirSync(source)) {
    requireCondition(
      ++budget.entries <= 10_000,
      "UPGRADE_SNAPSHOT_TOO_LARGE",
      "Run snapshot exceeds its entry budget",
      4,
    );
    const from = join(source, entry),
      to = join(destination, entry);
    const metadata = lstatSync(from);
    if (metadata.isDirectory() && !metadata.isSymbolicLink())
      cloneDirectory(from, to, root, budget);
    else {
      requireCondition(
        metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1,
        "UNSAFE_PATH",
        "Upgrade snapshots accept only private regular files and directories",
        5,
      );
      const bytes = readRegularNoFollow(from, root, undefined, 256 * 1024 * 1024, sourceIdentity);
      budget.bytes += bytes.length;
      requireCondition(
        budget.bytes <= 256 * 1024 * 1024,
        "UPGRADE_SNAPSHOT_TOO_LARGE",
        "Run snapshot exceeds its byte budget",
        4,
      );
      writeExclusiveNoFollow(to, bytes, root, destinationIdentity);
    }
  }
  requireCondition(
    same(lstatSync(source), sourceIdentity),
    "UNSAFE_PATH",
    "Upgrade source directory changed",
    5,
  );
  syncDirectoryNoFollow(destination, root, destinationIdentity);
}

/** Same-parent exchange is one atomic OS operation: old callers can see only the source or the fenced candidate. */
function exchange(
  source: string,
  candidate: string,
  expectedSource: DirectoryIdentity,
  expectedCandidate: DirectoryIdentity,
): void {
  const parent = dirname(source);
  requireCondition(
    dirname(candidate) === parent && realpathSync(parent) === parent,
    "UNSAFE_PATH",
    "Upgrade publication requires one canonical parent",
    5,
  );
  const fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let library: ReturnType<typeof dlopen> | undefined;
  try {
    requireCondition(
      same(fstatSync(fd), lstatSync(parent)) &&
        same(lstatSync(source), expectedSource) &&
        same(lstatSync(candidate), expectedCandidate),
      "UNSAFE_PATH",
      "Upgrade publication identity changed",
      5,
    );
    const symbol = process.platform === "darwin" ? "renameatx_np" : "renameat2";
    requireCondition(
      ["darwin", "linux"].includes(process.platform),
      "UNSUPPORTED_PLATFORM",
      "Atomic run-directory exchange is unavailable",
      6,
    );
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    for (const name of process.platform === "darwin"
      ? ["libSystem.B.dylib"]
      : ["libc.so.6", `libc.musl-${arch}.so.1`, "libc.so"]) {
      try {
        library = dlopen(name, {
          [symbol]: {
            args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
            returns: FFIType.i32,
          },
        });
        break;
      } catch {}
    }
    requireCondition(
      library,
      "UNSUPPORTED_PLATFORM",
      "Atomic run-directory exchange is unavailable",
      6,
    );
    const rename = library.symbols[symbol] as (
      a: number,
      b: Uint8Array,
      c: number,
      d: Uint8Array,
      flags: number,
    ) => number;
    requireCondition(
      rename(
        fd,
        new TextEncoder().encode(basename(source) + "\0"),
        fd,
        new TextEncoder().encode(basename(candidate) + "\0"),
        2,
      ) === 0,
      "UPGRADE_PUBLICATION_FAILED",
      "Atomic run-directory exchange failed; source and staging are retained",
      5,
    );
    // macOS RENAME_SWAP and Linux RENAME_EXCHANGE both use flag 2.
    requireCondition(
      same(lstatSync(source), expectedCandidate) && same(lstatSync(candidate), expectedSource),
      "UNSAFE_PATH",
      "Published directory identity changed",
      5,
    );
    syncDirectoryNoFollow(parent, undefined, fstatSync(fd));
  } finally {
    library?.close();
    closeSync(fd);
  }
}
export function publishUpgradeDirectory(options: {
  root: string;
  runPath: string;
  sourceIdentity: DirectoryIdentity;
  snapshotName: string;
  ledger: unknown;
  binding: unknown;
  afterStage?: (phase: string) => void;
}): DirectoryIdentity {
  requireCondition(
    /^\.upgrade-[a-f0-9-]{36}$/.test(options.snapshotName),
    "UNSAFE_PATH",
    "Invalid upgrade snapshot name",
    5,
  );
  const snapshot = join(dirname(options.runPath), options.snapshotName);
  cloneDirectory(options.runPath, snapshot, options.root);
  const candidateIdentity = lstatSync(snapshot);
  writeAtomicNoFollow(
    join(snapshot, "ledger.json"),
    JSON.stringify(options.ledger, null, 2) + "\n",
    options.root,
    undefined,
    candidateIdentity,
  );
  writeAtomicNoFollow(
    join(snapshot, "runtime", "viewer-binding.json"),
    JSON.stringify(options.binding) + "\n",
    options.root,
  );
  syncDirectoryNoFollow(snapshot, options.root, candidateIdentity);
  syncDirectoryNoFollow(dirname(snapshot), options.root);
  options.afterStage?.("candidate_synced");
  exchange(resolve(options.runPath), snapshot, options.sourceIdentity, candidateIdentity);
  options.afterStage?.("directory_exchanged");
  return candidateIdentity;
}
