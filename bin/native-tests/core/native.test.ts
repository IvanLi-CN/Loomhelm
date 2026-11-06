import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  realpath,
  chmod,
  link,
  mkdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRegularNoFollow,
  tryLockFile,
} from "../../modules/core/security_file";

describe("native lock and path behavior", () => {
  const nativeTest = test.skipIf(
    process.platform !== "darwin" && process.platform !== "linux",
  );

  nativeTest(
    "exclusive flock rejects a second holder until release",
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "core-lock-")));
      try {
        const lockPath = join(root, "lock");
        const first = tryLockFile(lockPath);
        expect(first).not.toBeNull();
        expect(tryLockFile(lockPath)).toBeNull();
        first?.release();
        const afterRelease = tryLockFile(lockPath);
        expect(afterRelease).not.toBeNull();
        afterRelease?.release();
        await symlink(root, join(root, "parent-alias"));
        expect(() =>
          tryLockFile(join(root, "parent-alias", "unsafe-lock")),
        ).toThrow("secure_lock_parent_rejected");

        const shared = join(root, "shared");
        await mkdir(shared, { mode: 0o700 });
        await chmod(shared, 0o770);
        expect(() => tryLockFile(join(shared, "unsafe-lock"))).toThrow(
          "secure_lock_parent_rejected",
        );

        const nested = join(shared, "nested");
        await mkdir(nested, { mode: 0o700 });
        expect(() => tryLockFile(join(nested, "unsafe-lock"))).toThrow(
          "secure_lock_parent_rejected",
        );

        const target = join(root, "target");
        const linkedLock = join(root, "linked-lock");
        await writeFile(target, "preserve mode");
        await link(target, linkedLock);
        const modeBefore = (await stat(target)).mode;
        expect(() => tryLockFile(linkedLock)).toThrow(
          "secure_lock_file_changed",
        );
        expect((await stat(target)).mode).toBe(modeBefore);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  nativeTest(
    "no-follow reads reject a symlink and accept a regular single-link file",
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "core-path-")));
      try {
        const file = join(root, "data");
        await writeFile(file, "safe");
        expect(new TextDecoder().decode(await readRegularNoFollow(file))).toBe(
          "safe",
        );
        await mkdir(join(root, "outside"));
        await symlink(file, join(root, "alias"));
        await expect(
          readRegularNoFollow(join(root, "alias")),
        ).rejects.toThrow();
        const hardlink = join(root, "hardlink");
        await link(file, hardlink);
        await expect(readRegularNoFollow(hardlink)).rejects.toThrow(
          "secure_file_type_rejected",
        );
        const fifo = join(root, "fifo");
        const created = Bun.spawnSync(["mkfifo", fifo]);
        expect(created.exitCode).toBe(0);
        await expect(readRegularNoFollow(fifo)).rejects.toThrow(
          "secure_file_type_rejected",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
