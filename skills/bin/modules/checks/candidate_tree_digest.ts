import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

type TreeEntry = { mode: string; path: string; objectId: string };

function git(root: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd: root, encoding: "buffer" });
}

function assertClean(root: string): void {
  if (git(root, ["status", "--porcelain", "--untracked-files=all"]).length)
    throw new Error("candidate worktree is dirty");
}

function treeEntries(root: string, revision: string): TreeEntry[] {
  const output = git(root, ["ls-tree", "-r", "-z", revision]);
  return output
    .subarray(0, output.length - (output.at(-1) === 0 ? 1 : 0))
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [header, path] = entry.split("\t");
      const [mode, type, objectId] = header?.split(" ") ?? [];
      if (!mode || type !== "blob" || !objectId || !path)
        throw new Error("candidate tree entry is malformed");
      return { mode, path, objectId };
    });
}

function batchContents(
  root: string,
  entries: TreeEntry[],
): Map<string, Buffer> {
  const requests = Buffer.from(
    entries.map(({ objectId }) => `${objectId}\n`).join(""),
  );
  const requested = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: requests,
    encoding: "buffer",
  });
  const contents = new Map<string, Buffer>();
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = requested.indexOf(10, offset);
    if (headerEnd < 0)
      throw new Error("candidate tree batch output is truncated");
    const header = requested
      .subarray(offset, headerEnd)
      .toString("utf8")
      .split(" ");
    if (
      header.length !== 3 ||
      header[0] !== entry.objectId ||
      header[1] !== "blob"
    )
      throw new Error("candidate tree contains a non-blob or missing entry");
    const size = Number(header[2]);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error("candidate tree batch size is malformed");
    const start = headerEnd + 1;
    const end = start + size;
    if (requested.length < end + 1 || requested[end] !== 10)
      throw new Error("candidate tree batch content is truncated");
    contents.set(entry.objectId, requested.subarray(start, end));
    offset = end + 1;
  }
  return contents;
}

function assertSafePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("candidate tree path is unsafe");
}

function readWorktreeEntry(root: string, entry: TreeEntry): Buffer {
  assertSafePath(entry.path);
  const parts = entry.path.split("/");
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("candidate worktree parent differs");
  }
  const leaf = join(parent, parts.at(-1)!);
  const stat = lstatSync(leaf);
  let content: Buffer;
  if (entry.mode === "100644" || entry.mode === "100755") {
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("candidate worktree entry type differs");
    const executable = (stat.mode & 0o111) !== 0;
    if (executable !== (entry.mode === "100755"))
      throw new Error("candidate worktree entry mode differs");
    content = readFileSync(leaf);
  } else if (entry.mode === "120000") {
    if (!stat.isSymbolicLink())
      throw new Error("candidate worktree entry type differs");
    content = Buffer.from(readlinkSync(leaf));
  } else throw new Error("candidate tree entry mode is unsupported");
  const finalStat = lstatSync(leaf);
  if (
    finalStat.dev !== stat.dev ||
    finalStat.ino !== stat.ino ||
    finalStat.size !== stat.size
  )
    throw new Error("candidate worktree entry changed during validation");
  return content;
}

function frame(digest: ReturnType<typeof createHash>, value: Buffer): void {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(value.length));
  digest.update(length).update(value);
}

export function candidateGitTreeDigest(
  root: string,
  revision: string,
  fixtureRelative: string,
): string {
  const candidateRoot = realpathSync(resolve(root));
  assertClean(candidateRoot);
  const entries = treeEntries(candidateRoot, revision);
  const contents = batchContents(candidateRoot, entries);
  const digest = createHash("sha256");
  let fixtureSeen = false;
  for (const entry of entries) {
    const expected = contents.get(entry.objectId);
    if (!expected) throw new Error("candidate tree object is missing");
    const actual = readWorktreeEntry(candidateRoot, entry);
    if (!actual.equals(expected))
      throw new Error("candidate worktree content differs");
    let framed = expected;
    if (entry.path === fixtureRelative) {
      fixtureSeen = true;
      const text = expected.toString("utf8");
      const digestField =
        /(\"candidate_digest\"\s*:\s*\")[0-9a-f]{64}(\"\s*[,}])/;
      if (!digestField.test(text))
        throw new Error("candidate digest field is malformed");
      const replaced = text.replace(digestField, `$1${"0".repeat(64)}$2`);
      framed = Buffer.from(replaced);
    }
    frame(digest, Buffer.from(entry.mode));
    frame(digest, Buffer.from(entry.path));
    frame(digest, framed);
  }
  assertClean(candidateRoot);
  if (!fixtureSeen) throw new Error("candidate digest fixture is not tracked");
  return digest.digest("hex");
}
