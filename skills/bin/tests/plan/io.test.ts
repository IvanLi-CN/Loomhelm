import { describe, expect, test } from "bun:test";
import {
  link,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeCandidateText } from "../../modules/plan/io";

describe("candidate output IO", () => {
  test("writes through a stable parent directory and rejects hardlinks", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "plan-io-")));
    try {
      const output = join(root, "manifest.json");
      await writeCandidateText(output, "first\n", root);
      expect(await readFile(output, "utf8")).toBe("first\n");

      const target = join(root, "target.txt");
      const hardlink = join(root, "hardlink.txt");
      await writeFile(target, "keep\n", "utf8");
      await link(target, hardlink);
      await expect(
        writeCandidateText(hardlink, "replace\n", root),
      ).rejects.toThrow("hardlinks are forbidden");
      expect(await readFile(target, "utf8")).toBe("keep\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects symlinked output parents", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "plan-io-")));
    const outside = await realpath(
      await mkdtemp(join(tmpdir(), "plan-io-outside-")),
    );
    try {
      const linkPath = join(root, "linked");
      await symlink(outside, linkPath);
      await expect(
        writeCandidateText(join(linkPath, "manifest.json"), "value\n", root),
      ).rejects.toThrow("symlink");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("rejects output paths outside the candidate root", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "plan-io-")));
    const outside = join(root, "..", "outside-manifest.json");
    try {
      await expect(
        writeCandidateText(outside, "value\n", root),
      ).rejects.toThrow("escapes PLAN_CONTRACT_REPO_ROOT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
