import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { candidateGitTreeDigest } from "../../modules/checks";

test("candidate tree digest binds modes and rejects hidden or symlinked edits", () => {
  const temporary = mkdtempSync(join(tmpdir(), "checks-tree-digest-"));
  const git = (root: string, args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = (root: string): string => {
    git(root, ["add", "--all"]);
    git(root, ["commit", "--quiet", "-m", "candidate"]);
    return git(root, ["rev-parse", "HEAD"]);
  };
  const createRepo = (
    name: string,
    files: Record<string, string | Buffer>,
  ): { root: string; head: string } => {
    const root = join(temporary, name);
    mkdirSync(root, { recursive: true });
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    git(root, ["config", "user.name", "Test User"]);
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, path);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }
    return { root, head: commit(root) };
  };
  try {
    const candidate = Buffer.from(
      '{"candidate_digest": "' + "0".repeat(64) + '"}\n',
    );
    const mode = createRepo("mode", {
      "candidate.json": candidate,
      "mode.txt": "same content\n",
    });
    const firstDigest = candidateGitTreeDigest(
      mode.root,
      mode.head,
      "candidate.json",
    );
    chmodSync(join(mode.root, "mode.txt"), 0o755);
    git(mode.root, ["update-index", "--chmod=+x", "mode.txt"]);
    const secondHead = commit(mode.root);
    expect(
      candidateGitTreeDigest(mode.root, secondHead, "candidate.json"),
    ).not.toBe(firstDigest);

    const collisionA = createRepo("collision-a", {
      "candidate.json": candidate,
      a: Buffer.from("x\0" + "100644\0b\0y"),
    });
    const collisionB = createRepo("collision-b", {
      "candidate.json": candidate,
      a: "x",
      b: "y",
    });
    expect(
      candidateGitTreeDigest(
        collisionA.root,
        collisionA.head,
        "candidate.json",
      ),
    ).not.toBe(
      candidateGitTreeDigest(
        collisionB.root,
        collisionB.head,
        "candidate.json",
      ),
    );

    const hidden = createRepo("hidden", {
      "candidate.json": candidate,
      "tracked.txt": "committed\n",
    });
    writeFileSync(join(hidden.root, "tracked.txt"), "hidden edit\n");
    git(hidden.root, ["update-index", "--skip-worktree", "tracked.txt"]);
    expect(() =>
      candidateGitTreeDigest(hidden.root, hidden.head, "candidate.json"),
    ).toThrow("content differs");

    const symlinked = createRepo("symlinked", {
      "candidate.json": candidate,
      "nested/tracked.txt": "committed\n",
    });
    const external = join(temporary, "external");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "tracked.txt"), "committed\n");
    rmSync(join(symlinked.root, "nested"), { recursive: true });
    symlinkSync(external, join(symlinked.root, "nested"), "dir");
    writeFileSync(join(symlinked.root, ".git/info/exclude"), "nested\n");
    git(symlinked.root, [
      "update-index",
      "--skip-worktree",
      "nested/tracked.txt",
    ]);
    expect(() =>
      candidateGitTreeDigest(symlinked.root, symlinked.head, "candidate.json"),
    ).toThrow("parent differs");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
