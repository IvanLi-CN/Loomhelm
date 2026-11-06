import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import {
  compareVisualEvidence,
  openNoFollow,
} from "../../modules/visual/compare";
import { checkText } from "../../modules/visual/gate";
import {
  runSandboxedCommand,
  sandboxAvailable,
} from "../../modules/visual/isolation";
import {
  CHECK_FAILED_EXIT,
  documentMain,
  hookPaths,
  migratePath,
} from "../../modules/visual/document";
import { createReport } from "../../modules/visual/report_create";
import { auditReport } from "../../modules/visual/report_audit";
import {
  htmlReportIssue,
  reportLayoutIssue,
} from "../../modules/visual/report_artifacts";
import { snapshotPath } from "../../modules/visual/report_validate";
import {
  containedPathWithoutSymlinks,
  isPlatformPathAlias,
  repoScope,
} from "../../modules/visual/paths";
import {
  copyFileExclusiveNoFollow,
  readRegularNoFollow,
  renameNoReplace,
  writeExclusiveNoFollow,
} from "../../modules/visual/secure_io";
import { createSnapshot } from "../../modules/visual/snapshot";
import { IMAGE_INPUT_MAX_BYTES, decodeImage } from "../../modules/visual/image";
import {
  detectContentBbox,
  desiredPadding,
  trimFile,
} from "../../modules/visual/trim";

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function reportInputs(root: string): {
  store: string;
  expected: string;
  actual: string;
} {
  const store = join(root, "user-inline-assets");
  const source = join(root, "source.png");
  writeFileSync(source, "snapshot");
  const now = new Date("2026-10-27T01:02:03.000Z");
  return {
    store,
    expected: createSnapshot({
      source,
      cwd: root,
      storeRoot: store,
      now,
      rand8: "00000001",
    }).snapshot_path,
    actual: createSnapshot({
      source,
      cwd: root,
      storeRoot: store,
      now,
      rand8: "00000002",
    }).snapshot_path,
  };
}

function validRunner(directory: string): undefined {
  const filename = readdirSync(join(directory, "actual"))[0] as string;
  writeFileSync(
    join(directory, "report.html"),
    `<html><div id="app"></div><script>window['__reg__'] = ${JSON.stringify({
      actualDir: "./actual",
      expectedDir: "./expected",
      diffDir: "./diff",
      newItems: [],
      deletedItems: [],
      hasNew: false,
      hasDeleted: false,
      hasFailed: true,
      hasPassed: false,
      failedItems: [{ raw: filename, encoded: filename }],
      passedItems: [],
    })};</script><script>function renderReport(){ return 'rendered reg-cli application'; }</script></html>`,
  );
  writeFileSync(
    join(directory, "reg.json"),
    JSON.stringify({
      actualItems: [filename],
      expectedItems: [filename],
      failedItems: [filename],
      passedItems: [],
      diffItems: [`${filename.slice(0, -4)}.png`],
    }),
  );
  writeFileSync(
    join(directory, "diff", `${filename.slice(0, -4)}.png`),
    "diff",
  );
  return undefined;
}

describe("visual review regressions", () => {
  test("copying a validated source never follows a replacement symlink", () => {
    const root = tempRoot("visual-copy-no-follow-");
    const outside = join(root, "outside.txt");
    const source = join(root, "source.txt");
    const destination = join(root, "destination.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, source);
    expect(() =>
      copyFileExclusiveNoFollow(source, destination, root),
    ).toThrow();
    expect(existsSync(destination)).toBe(false);
  });

  test("no-follow reads reject symlinked intermediate ancestors", () => {
    const root = tempRoot("visual-intermediate-no-follow-");
    const real = join(root, "real");
    const alias = join(root, "alias");
    mkdirSync(real);
    writeFileSync(join(real, "source.txt"), "source");
    symlinkSync(real, alias, "dir");
    expect(() =>
      copyFileExclusiveNoFollow(
        join(alias, "source.txt"),
        join(root, "destination.txt"),
        root,
      ),
    ).toThrow();
    expect(existsSync(join(root, "destination.txt"))).toBe(false);
  });

  test.skipIf(!["darwin", "linux"].includes(process.platform))(
    "no-follow reads reject non-regular files",
    () => {
      expect(() => readRegularNoFollow("/dev/zero")).toThrow("regular file");
    },
  );

  test("native open errors preserve ENAMETOOLONG instead of becoming EEXIST", () => {
    const root = tempRoot("visual-open-error-");
    const error = (() => {
      try {
        writeExclusiveNoFollow(join(root, "x".repeat(300)), "content", root);
        return undefined;
      } catch (value) {
        return value as NodeJS.ErrnoException;
      }
    })();
    expect(error?.code).not.toBe("EEXIST");
    expect(error?.code).toBe("ENAMETOOLONG");
  });

  test.skipIf(!["darwin", "linux"].includes(process.platform))(
    "atomic rename does not treat a missing source as a collision",
    () => {
      const root = tempRoot("visual-rename-error-");
      const error = (() => {
        try {
          renameNoReplace(
            join(root, "missing"),
            join(root, "destination"),
            root,
          );
          return undefined;
        } catch (value) {
          return value as NodeJS.ErrnoException;
        }
      })();
      expect(error?.code).not.toBe("EEXIST");
    },
  );

  test("raw traversal remembers an in-root symlink before dot-dot normalization", () => {
    const root = tempRoot("visual-contained-path-");
    const inside = join(root, "inside");
    const outside = join(root, "outside");
    mkdirSync(inside);
    mkdirSync(outside);
    writeFileSync(join(inside, "image.png"), "image");
    symlinkSync(outside, join(inside, "escape"), "dir");
    expect(
      containedPathWithoutSymlinks(`${inside}/escape/../image.png`, root),
    ).toBeNull();
  });

  test("repo scopes canonicalize non-git working directories", () => {
    const root = tempRoot("visual-repo-scope-");
    const real = join(root, "real");
    const alias = join(root, "alias");
    mkdirSync(real);
    symlinkSync(real, alias, "dir");
    expect(repoScope(alias).repoRoot).toBe(realpathSync(real));
  });

  test("document hooks collect top-level file paths", () => {
    expect(
      hookPaths({ file_path: "docs/specs/sample/SPEC.md" }, tempRoot("hook-")),
    ).toEqual(["docs/specs/sample/SPEC.md"]);
    expect(
      hookPaths(
        { file_path: "./docs//specs/./sample/SPEC.md" },
        tempRoot("hook-normalized-"),
      ),
    ).toEqual(["docs/specs/sample/SPEC.md"]);
  });

  test("snapshot expands a home-relative working directory", () => {
    const root = tempRoot("visual-snapshot-home-cwd-");
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const source = join(root, "source.png");
      writeFileSync(source, "snapshot");
      expect(
        createSnapshot({
          source: "source.png",
          cwd: "~",
          storeRoot: join(root, "store"),
          now: new Date("2026-10-27T01:02:03.000Z"),
          rand8: "00000001",
        }).source_path,
      ).toBe(realpathSync(source));
      const snapshot = createSnapshot({
        source: "source.png",
        cwd: "~",
        storeRoot: join(realpathSync(root), "store-two"),
        now: new Date("2026-10-27T01:02:03.000Z"),
        rand8: "00000002",
      });
      expect(
        snapshotPath(
          snapshot.snapshot_path.replace(realpathSync(root), "~"),
          "~/store-two",
        ),
      ).toBe(realpathSync(snapshot.snapshot_path));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("HTML mount validation requires the exact div tag name", () => {
    const root = tempRoot("visual-html-mount-name-");
    const html = join(root, "report.html");
    writeFileSync(
      html,
      `<div-placeholder id="app"></div-placeholder><script>window['__reg__'] = {};</script><script>function renderReport(){ return 'rendered'; }</script>`,
    );
    expect(
      htmlReportIssue(html, {
        actualItems: [],
        expectedItems: [],
        failedItems: [],
        passedItems: [],
        diffItems: [],
      }),
    ).toContain("missing");
  });

  test("publication rename rejects a parent that escapes its trusted root", () => {
    const root = tempRoot("visual-rename-root-");
    const outside = tempRoot("visual-rename-outside-");
    const alias = join(root, "alias");
    symlinkSync(outside, alias, "dir");
    const source = join(alias, "source");
    const destination = join(alias, "destination");
    mkdirSync(source);
    expect(() => renameNoReplace(source, destination, root)).toThrow();
    expect(lstatSync(source).isDirectory()).toBe(true);
  });

  test("the owner-facing gate uses UTF-16 offsets for emoji-prefixed markup", () => {
    const root = tempRoot("visual-gate-unicode-");
    const violation = checkText(
      "😀`x`![remote](https://example.test/image.png)",
      root,
    )[0];
    expect(violation).toBeDefined();
    expect(violation?.position).toBe(5);
  });

  test("the owner-facing gate matches casefold and rejects empty sources", () => {
    const root = tempRoot("visual-gate-casefold-");
    expect(
      checkText(
        "[strasse]: https://example.test/image.png\n![x][STRAẞE]",
        root,
      )[0]?.reason,
    ).toBe("non_snapshot_path");
    expect(
      checkText("[ὰι]: https://example.test/image.png\n![x][ᾲ]", root)[0]
        ?.reason,
    ).toBe("non_snapshot_path");
    const safe = join(root, "safe.png");
    writeFileSync(safe, "safe");
    expect(
      checkText(
        `[Ａ]: <${safe}>\n[A]: https://example.test/image.png\n![x][A]`,
        root,
      )[0]?.reason,
    ).toBe("non_snapshot_path");
    expect(checkText("![x]()", root)[0]?.reason).toBe("empty_image_source");
  });

  test("document checks reject missing changed-from values without running git", () => {
    expect(documentMain(["check", "--changed-from"])).toBe(CHECK_FAILED_EXIT);
  });

  test("document migration rejects hard-linked aliases before reading or writing", () => {
    const root = tempRoot("visual-document-hardlink-");
    const path = join(root, "docs/specs/sample/SPEC.md");
    const original = join(root, "original.md");
    mkdirSync(join(root, "docs/specs/sample"), { recursive: true });
    writeFileSync(original, "## Visual Evidence (PR)\n![asset](x.png)\n");
    linkSync(original, path);
    expect(() => migratePath(root, "docs/specs/sample/SPEC.md")).toThrow(
      "hard-linked alias",
    );
    expect(readFileSync(original, "utf8")).toContain("Visual Evidence (PR)");
  });

  test("document migration rejects invalid UTF-8 without rewriting the file", () => {
    const root = tempRoot("visual-document-utf8-");
    const path = join(root, "docs/specs/sample/SPEC.md");
    const bytes = Buffer.concat([
      Buffer.from("## Visual Evidence (PR)\n"),
      Buffer.from([0xff]),
    ]);
    mkdirSync(join(root, "docs/specs/sample"), { recursive: true });
    writeFileSync(path, bytes);
    expect(() => migratePath(root, "docs/specs/sample/SPEC.md")).toThrow(
      "unreadable",
    );
    expect(readFileSync(path)).toEqual(bytes);
  });

  test("report publication reparses the cloned reg-cli JSON", () => {
    const root = tempRoot("visual-report-reg-reparse-");
    const inputs = reportInputs(root);
    expect(() =>
      createReport({
        pairs: [
          { name: "page", expected: inputs.expected, actual: inputs.actual },
        ],
        cwd: root,
        storeRoot: inputs.store,
        now: new Date("2026-10-27T01:02:03.000Z"),
        token: "00000001",
        runRegCli: validRunner,
        cloneFile: (source, destination) => {
          copyFileSync(source, destination);
          if (destination.endsWith("/reg.json"))
            writeFileSync(destination, "{");
        },
      }),
    ).toThrow("published reg-cli JSON is invalid");
  });

  test("snapshot paths reject impossible calendar timestamps", () => {
    const root = tempRoot("visual-snapshot-date-");
    const path = join(
      root,
      "repo__12345678/2026/02/31/20260231T010203Z-image-00000001.png",
    );
    mkdirSync(join(root, "repo__12345678/2026/02/31"), { recursive: true });
    writeFileSync(path, "image");
    expect(() => snapshotPath(path, root)).toThrow("generated chat snapshot");
  });

  test("report contracts reject invalid and timezone-naive timestamps", () => {
    const root = tempRoot("visual-report-timestamp-");
    const report = join(
      root,
      "repo__12345678/2026/10/27/reg-cli-reports/20261027T010203Z-token",
    );
    const manifest = { repo_scope: "repo__12345678" };
    expect(
      reportLayoutIssue(report, root, {
        ...manifest,
        created_at_utc: "2026-02-30T01:02:03.000Z",
      }),
    ).toContain("manifest");
    expect(
      reportLayoutIssue(report, root, {
        ...manifest,
        created_at_utc: "2026-10-27T09:02:03.123456+08:00",
      }),
    ).toBeUndefined();
    expect(
      reportLayoutIssue(report, root, {
        ...manifest,
        created_at_utc: "2026-10-27T01:02:03.123456",
      }),
    ).toContain("manifest");
  });

  test("snapshot publication leaves no temporary artifact on collision", () => {
    const root = tempRoot("visual-snapshot-publication-");
    const store = join(root, "user-inline-assets");
    const source = join(root, "source.png");
    writeFileSync(source, "snapshot");
    const options = {
      source,
      cwd: root,
      storeRoot: store,
      now: new Date("2026-10-27T01:02:03.000Z"),
      rand8: "00000001",
    };
    const first = createSnapshot(options);
    expect(() => createSnapshot(options)).toThrow("already exists");
    expect(readdirSync(dirname(first.snapshot_path))).toEqual([
      basename(first.snapshot_path),
    ]);
  });

  test("report audit returns a broken result when its store is missing", () => {
    const root = tempRoot("visual-report-missing-store-");
    const result = auditReport(join(root, "report"), join(root, "missing"));
    expect(result.status).toBe("broken");
  });

  test("report audit expands home-relative paths", () => {
    const root = tempRoot("visual-report-home-paths-");
    mkdirSync(join(root, "store"));
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      expect(auditReport("~/report", "~/store").issues).toEqual([
        "report directory must be under the snapshot store",
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("comparison rejects an arbitrary symlinked output ancestor", async () => {
    const root = tempRoot("visual-compare-output-root-");
    const outside = join(root, "outside");
    const alias = join(root, "alias");
    mkdirSync(outside);
    symlinkSync(outside, alias, "dir");
    await expect(
      compareVisualEvidence(
        "not-a-revision",
        [],
        join(alias, "heatmaps"),
        root,
      ),
    ).rejects.toThrow("must not contain symlinks");
    expect(readdirSync(outside)).toEqual([]);
  });

  test("comparison image decoding enforces the configured pixel ceiling", async () => {
    const input = await sharp(Buffer.alloc(8, 255), {
      raw: { width: 2, height: 1, channels: 4 },
    })
      .png()
      .toBuffer();
    await expect(decodeImage(input, { limitInputPixels: 1 })).rejects.toThrow(
      "pixel limit",
    );
  });

  test("trim matches Pillow luminance rounding at the threshold", () => {
    const data = Buffer.alloc(3 * 3 * 4);
    data.set([5, 17, 9, 255], (1 * 3 + 1) * 4);
    expect(
      detectContentBbox({ width: 3, height: 3, data }, [0, 0, 0, 255], 12),
    ).toEqual([1, 1, 2, 2]);
    data.set([9, 7, 50, 255], (1 * 3 + 1) * 4);
    expect(
      detectContentBbox({ width: 3, height: 3, data }, [0, 0, 0, 255], 12),
    ).toBeNull();
    expect(desiredPadding([0, 0, 1025, 1])).toBe(20);
    expect(desiredPadding([0, 0, 1075, 1])).toBe(22);
  });

  test("readability probes do not load large regular files", () => {
    const root = tempRoot("visual-gate-large-file-");
    const large = join(root, "large.png");
    writeFileSync(large, "");
    truncateSync(large, 1_000_000_000);
    expect(checkText(`![large](${large})`, root)).toEqual([]);
  });

  test("image reads reject inputs above the byte limit", () => {
    const root = tempRoot("visual-image-byte-limit-");
    const large = join(root, "large.png");
    writeFileSync(large, "");
    truncateSync(large, IMAGE_INPUT_MAX_BYTES + 1);
    expect(() => openNoFollow(large, root)).toThrow("read limit");
  });

  test("trim rejects Pillow decompression-bomb-sized images", async () => {
    const root = tempRoot("visual-trim-pixel-limit-");
    const input = join(root, "input.png");
    await sharp({
      create: {
        width: 20_000,
        height: 9_000,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toFile(input);
    await expect(trimFile(input, join(root, "output.png"))).rejects.toThrow(
      "pixel limit",
    );
  });

  test.skipIf(!sandboxAvailable())(
    "detached writers cannot modify sealed staging",
    async () => {
      const root = tempRoot("visual-sandbox-setsid-");
      const staging = join(root, "staging");
      mkdirSync(staging);
      const script = `const { dlopen, FFIType } = await import("bun:ffi"); const { writeFileSync } = await import("node:fs"); const libc = dlopen("libSystem.B.dylib", { fork: { args: [], returns: FFIType.i32 }, setsid: { args: [], returns: FFIType.i32 }, unsetenv: { args: [FFIType.cstring], returns: FFIType.i32 }, close: { args: [FFIType.i32], returns: FFIType.i32 } }); const pid = libc.symbols.fork(); if (pid === 0) { libc.symbols.setsid(); libc.symbols.unsetenv("CODEX_VISUAL_SANDBOX_TOKEN"); libc.symbols.close(0); libc.symbols.close(1); libc.symbols.close(2); writeFileSync("ready", "ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800); writeFileSync("late-child", "late"); process.exit(0); } await Bun.sleep(200); if (!(await Bun.file("ready").exists())) process.exit(1);`;
      runSandboxedCommand(staging, [process.execPath, "-e", script], {
        runtimeDir: join(staging, "runtime"),
        env: { PATH: "/usr/bin:/bin" },
        allowNetwork: false,
        label: "setsid-child",
        workingDirectory: staging,
      });
      const sealed = join(root, "sealed");
      renameSync(staging, sealed);
      await Bun.sleep(900);
      expect(existsSync(join(sealed, "late-child"))).toBe(false);
    },
  );

  test("platform path aliases are explicit rather than arbitrary", () => {
    expect(isPlatformPathAlias("/definitely-not-an-alias")).toBe(false);
    if (process.platform === "darwin")
      expect(isPlatformPathAlias("/var")).toBe(true);
  });
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
