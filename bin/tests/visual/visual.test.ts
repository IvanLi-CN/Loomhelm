import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { compareVisualEvidence } from "../../modules/visual/compare";
import {
  checkMessage,
  checkText,
  evaluatePayload,
} from "../../modules/visual/gate";
import {
  cloneReportFile,
  runSandboxedCommand,
  sandboxAvailable,
} from "../../modules/visual/isolation";
import {
  createReport,
  auditReport,
  type ImagePair,
} from "../../modules/visual/report";
import { validatedItemLists } from "../../modules/visual/report_validate";
import { createSnapshot } from "../../modules/visual/snapshot";
import {
  detectContentBbox,
  REQUIRE_MARGIN,
  trimFile,
} from "../../modules/visual/trim";
import { checkPath, migratePath } from "../../modules/visual/document";
import {
  defaultCodexHome,
  resolveExistingFile,
} from "../../modules/visual/paths";
import { writeExclusiveNoFollow } from "../../modules/visual/secure_io";

const roots: string[] = [];
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeImage(
  path: string,
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Promise<void> {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = pixel(x, y);
      data.set(value, offset);
    }
  await sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(path);
}

function initGitRepo(root: string): string {
  mkdirSync(join(root, "assets"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "visual@example.test"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Visual Tests"], { cwd: root });
  return root;
}

describe("visual migration adapters", () => {
  test("snapshots are unique, immutable, and ASCII-safe", () => {
    const root = tempRoot("visual-snapshot-");
    const store = join(root, "user-inline-assets");
    const source = join(root, "截图.图像");
    writeFileSync(source, "before");
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const homeSource = join(root, "home-source.png");
      writeFileSync(homeSource, "home");
      expect(resolveExistingFile("~/home-source.png", resolve("."))).toBe(
        realpathSync(homeSource),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
    const now = new Date("2026-10-27T01:02:03.000Z");
    const first = createSnapshot({
      source,
      cwd: resolve("."),
      storeRoot: store,
      now,
      rand8: "00000001",
    });
    expect(first.snapshot_path).toContain("/2026/10/27/");
    expect(first.snapshot_path).toMatch(/-[a-z0-9-]+-00000001\.img$/);
    writeFileSync(source, "after");
    const second = createSnapshot({
      source,
      cwd: resolve("."),
      storeRoot: store,
      now,
      rand8: "00000002",
    });
    expect(second.snapshot_path).not.toBe(first.snapshot_path);
    expect(readFileSync(first.snapshot_path, "utf8")).toBe("before");
    expect(() =>
      createSnapshot({
        source,
        cwd: resolve("."),
        storeRoot: store,
        now,
        rand8: "00000001",
      }),
    ).toThrow("already exists");

    const previousCodexHome = process.env.CODEX_HOME;
    const previousHomeForFallback = process.env.HOME;
    process.env.CODEX_HOME = "";
    process.env.HOME = join(root, "home-without-codex");
    expect(defaultCodexHome()).toBe(resolve(import.meta.dir, "../../.."));
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousHomeForFallback === undefined) delete process.env.HOME;
    else process.env.HOME = previousHomeForFallback;

    const outsideStore = join(root, "outside-store");
    mkdirSync(outsideStore);
    const symlinkedStore = join(root, "symlinked-store");
    symlinkSync(outsideStore, symlinkedStore, "dir");
    expect(() =>
      createSnapshot({
        source,
        cwd: resolve("."),
        storeRoot: symlinkedStore,
        now,
        rand8: "00000003",
      }),
    ).toThrow("directory component is unsafe");
    expect(readdirSync(outsideStore)).toEqual([]);

    const outsideTarget = join(root, "outside-target");
    mkdirSync(outsideTarget);
    const unsafeStore = join(root, "unsafe-store");
    mkdirSync(unsafeStore);
    const scopeName = readdirSync(store)[0] as string;
    symlinkSync(outsideTarget, join(unsafeStore, scopeName), "dir");
    expect(() =>
      createSnapshot({
        source,
        cwd: resolve("."),
        storeRoot: unsafeStore,
        now,
        rand8: "00000004",
      }),
    ).toThrow("directory component is unsafe");
    expect(readdirSync(outsideTarget)).toEqual([]);

    expect(() =>
      createSnapshot({
        source,
        cwd: resolve("."),
        storeRoot: store,
        now,
        rand8: "../escape",
      }),
    ).toThrow("snapshot token");
  });

  test("owner-facing gate accepts snapshots and rejects remote, relative, and missing links", () => {
    const root = tempRoot("visual-gate-");
    const snapshot = join(
      root,
      "repo__12345678",
      "2026",
      "10",
      "27",
      "20261027T010203Z-image-00000001.png",
    );
    mkdirSync(join(root, "repo__12345678", "2026", "10", "27"), {
      recursive: true,
    });
    writeFileSync(snapshot, "image");
    expect(checkText(`![ok](${snapshot})`, root)).toEqual([]);
    expect(
      checkText(`<img alt="a > b" src="https://example.test/image.png">`, root),
    ).toHaveLength(1);
    const missing = join(
      realpathSync(root),
      "repo__12345678",
      "2026",
      "10",
      "27",
      "20261027T010203Z-missing-00000001.png",
    );
    expect(checkText(`![missing](${missing})`, root)[0]?.reason).toBe(
      "snapshot_missing",
    );
    expect(
      checkText(
        "![remote](https://example.test/image.png)\n![relative](image.png)",
        root,
      ),
    ).toHaveLength(2);
    expect(
      checkText(
        "```md\n![example](https://example.test/image.png)\n```\n`![inline](x.png)`",
        root,
      ),
    ).toEqual([]);
    expect(checkMessage({ type: "image", data: "native" }, root)).toEqual([]);
    expect(
      evaluatePayload(
        { last_assistant_message: "![bad](https://example.test/image.png)" },
        root,
      ).decision,
    ).toBe("block");
    expect(
      evaluatePayload(
        {
          last_assistant_message: "![bad](https://example.test/image.png)",
          stop_hook_active: true,
        },
        root,
      ).continue,
    ).toBe(false);
  });

  test("trim preserves require_margin blocking and trims uniform page edges", async () => {
    const root = tempRoot("visual-trim-");
    const input = join(root, "input.png");
    const output = join(root, "output.png");
    await writeImage(input, 100, 100, (x, y) =>
      x >= 30 && x < 70 && y >= 30 && y < 70
        ? [0, 0, 0, 255]
        : [255, 255, 255, 255],
    );
    const blockedOutput = join(root, "blocked.png");
    const blocked = await trimFile(input, blockedOutput, {
      marginPolicy: REQUIRE_MARGIN,
      evidenceSurface: "component",
    });
    expect(blocked.action).toBe("blocked");
    expect(blocked.reason).toBe("source_managed_surface_required");
    expect(readFileSync(blockedOutput)).toEqual(readFileSync(input));
    const trimmed = await trimFile(input, output);
    expect(trimmed.action).toBe("cropped");
    expect(trimmed.trimmed_pixels.left).toBeGreaterThan(0);
    expect((await sharp(output).metadata()).width).toBeLessThan(100);
    const jpegInput = join(root, "input.jpg");
    const pngOutput = join(root, "output-from-jpeg.png");
    await sharp(input).jpeg().toFile(jpegInput);
    await trimFile(jpegInput, pngOutput);
    expect((await sharp(pngOutput).metadata()).format).toBe("png");
    const flat = join(root, "flat.png");
    await writeImage(flat, 20, 20, () => [255, 255, 255, 255]);
    await expect(trimFile(flat, join(root, "output.bmp"))).rejects.toThrow(
      "unsupported image output format",
    );
    const subtle = Buffer.alloc(3 * 3 * 4, 255);
    subtle[(1 * 3 + 1) * 4 + 2] = 242;
    expect(
      detectContentBbox(
        { width: 3, height: 3, data: subtle },
        [255, 255, 255, 255],
        12,
      ),
    ).toBeNull();
  });

  test("comparison reports transparent pixel changes and same-path current-only state", async () => {
    const repo = initGitRepo(tempRoot("visual-compare-repo-"));
    const baseline = join(repo, "assets", "view.png");
    const candidate = join(tempRoot("visual-compare-candidate-"), "view.png");
    await writeImage(baseline, 4, 4, () => [255, 255, 255, 255]);
    await writeImage(candidate, 4, 4, (x, y) =>
      x === 1 && y === 1 ? [255, 255, 255, 0] : [255, 255, 255, 255],
    );
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const report = await compareVisualEvidence(
      baseSha,
      [
        ["./assets//view.png", candidate],
        ["assets/./view.png", candidate],
      ],
      join(repo, "heatmaps"),
      repo,
    );
    expect(report.status).toBe("comparison_unavailable");
    expect(report.candidate_pairs).toEqual([
      { destination: "assets/view.png", candidate },
    ]);
    expect(
      (report.pairs as Array<Record<string, unknown>>)[0]?.changed_pixel_count,
    ).toBe(1);
    expect(
      (report.pairs as Array<Record<string, unknown>>)[0]?.max_channel_delta,
    ).toBe(255);
    const currentOnly = await compareVisualEvidence(
      baseSha,
      [["assets/new.png", candidate]],
      join(repo, "heatmaps-2"),
      repo,
    );
    expect(currentOnly.status).toBe("current-only");
    const traversal = await compareVisualEvidence(
      baseSha,
      [["../escape.png", candidate]],
      join(repo, "heatmaps-3"),
      repo,
    );
    expect(traversal.status).toBe("comparison_unavailable");
    const alias = join(repo, "alias.png");
    symlinkSync(candidate, alias);
    const symlinked = await compareVisualEvidence(
      baseSha,
      [["assets/view.png", alias]],
      join(repo, "heatmaps-4"),
      repo,
    );
    expect(symlinked.status).toBe("comparison_unavailable");
    const rawTraversal = await compareVisualEvidence(
      baseSha,
      [["assets/view.png", `${alias}/../assets/view.png`]],
      join(repo, "heatmaps-raw-traversal"),
      repo,
    );
    expect(rawTraversal.status).toBe("comparison_unavailable");
    const unsafeHeatmap = join(repo, "outside-heatmap.png");
    writeFileSync(unsafeHeatmap, "keep");
    const symlinkedOutput = join(repo, "heatmaps-5");
    mkdirSync(symlinkedOutput);
    symlinkSync(unsafeHeatmap, join(symlinkedOutput, "pair-01-heatmap.png"));
    const unsafeOutput = await compareVisualEvidence(
      baseSha,
      [["assets/view.png", candidate]],
      symlinkedOutput,
      repo,
    );
    expect(unsafeOutput.status).toBe("comparison_unavailable");
    expect(readFileSync(unsafeHeatmap, "utf8")).toBe("keep");
    const outsideOutput = join(repo, "outside-output");
    mkdirSync(outsideOutput);
    const outputAncestor = join(repo, "output-alias");
    symlinkSync(outsideOutput, outputAncestor, "dir");
    let outputError = "";
    try {
      await compareVisualEvidence(
        baseSha,
        [["assets/view.png", candidate]],
        join(outputAncestor, "nested"),
        repo,
      );
    } catch (error) {
      outputError = error instanceof Error ? error.message : String(error);
    }
    expect(outputError).toContain("must not contain symlinks");
    expect(readdirSync(outsideOutput)).toEqual([]);
    const literalDestination = "assets/literal\\name.png";
    await writeImage(join(repo, "assets", "literal\\name.png"), 4, 4, () => [
      255, 255, 255, 255,
    ]);
    execFileSync("git", ["add", "--", literalDestination], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "literal backslash path"], {
      cwd: repo,
    });
    const literalBaseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const literalReport = await compareVisualEvidence(
      literalBaseSha,
      [[literalDestination, candidate]],
      join(repo, "heatmaps-literal"),
      repo,
    );
    expect(literalReport.status).toBe("compared");
    const badBaseline = join(repo, "assets", "bad.png");
    writeFileSync(badBaseline, "not an image");
    execFileSync("git", ["add", "assets/bad.png"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "bad baseline"], { cwd: repo });
    const badBaseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const badBaselineReport = await compareVisualEvidence(
      badBaseSha,
      [["assets/bad.png", candidate]],
      join(repo, "heatmaps-6"),
      repo,
    );
    expect(
      (badBaselineReport.pairs as Array<Record<string, unknown>>)[0]?.status,
    ).toBe("baseline_unreadable");
  });

  test("document migration normalizes legacy evidence and preserves asset paths", () => {
    const root = tempRoot("visual-document-");
    const relativePath = "docs/specs/sample/SPEC.md";
    const path = join(root, relativePath);
    mkdirSync(join(root, "docs/specs/sample"), { recursive: true });
    writeFileSync(
      path,
      "# Sample\n\n## Visual Evidence (PR)\nPR: include\n![asset](assets/view.png)\n",
    );
    const result = migratePath(root, relativePath);
    expect(result.changed).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(
      "## Visual Evidence\n![asset](assets/view.png)",
    );
    expect(checkPath(root, relativePath).state).toBe("passed");
    writeFileSync(
      path,
      "## Visual Evidence\n![one](a.png)\n## Visual Evidence (PR)\n![two](b.png)\n",
    );
    expect(() => migratePath(root, relativePath)).toThrow("both_have_images");
    const escapeRoot = tempRoot("visual-document-symlink-");
    const outside = tempRoot("visual-document-outside-");
    const escapedPath = join(outside, "sample", "SPEC.md");
    mkdirSync(join(outside, "sample"), { recursive: true });
    writeFileSync(escapedPath, "## Visual Evidence (PR)\n![asset](x.png)\n");
    mkdirSync(join(escapeRoot, "docs"));
    symlinkSync(outside, join(escapeRoot, "docs", "specs"), "dir");
    expect(() => migratePath(escapeRoot, relativePath)).toThrow(
      "symlinked component",
    );
    expect(readFileSync(escapedPath, "utf8")).toContain("Visual Evidence (PR)");
  });

  test("report validation rejects comparison items outside the requested set", () => {
    expect(() =>
      validatedItemLists(
        {
          actualItems: ["page.png"],
          expectedItems: ["page.png"],
          failedItems: ["other.png"],
          passedItems: [],
          diffItems: ["other.png"],
        },
        new Set(["page.png"]),
      ),
    ).toThrow("could not compare every requested pair");
  });

  test("sandbox logs reject pre-created symlinks without writing through them", () => {
    const root = tempRoot("visual-log-safety-");
    const runtime = join(root, "runtime");
    mkdirSync(runtime);
    const outside = join(root, "outside.log");
    writeFileSync(outside, "keep");
    const directLog = join(runtime, "direct.stdout.log");
    symlinkSync(outside, directLog);
    expect(() => writeExclusiveNoFollow(directLog, "overwrite", root)).toThrow(
      "already present or unsafe",
    );
    expect(readFileSync(outside, "utf8")).toBe("keep");

    const safeLog = join(runtime, "safe.stdout.log");
    writeExclusiveNoFollow(safeLog, "captured", root);
    expect(readFileSync(safeLog, "utf8")).toBe("captured");
  });

  test.skipIf(!sandboxAvailable())(
    "sandbox log paths reject child-created symlinks",
    () => {
      const root = tempRoot("visual-child-log-safety-");
      const childRuntime = join(root, "child-runtime");
      mkdirSync(childRuntime);
      const childOutside = join(root, "child-outside.log");
      writeFileSync(childOutside, "keep");
      expect(() =>
        runSandboxedCommand(
          root,
          [
            "/bin/ln",
            "-s",
            childOutside,
            join(childRuntime, "child.stdout.log"),
          ],
          {
            runtimeDir: childRuntime,
            env: {},
            allowNetwork: false,
            label: "child",
            workingDirectory: root,
          },
        ),
      ).toThrow("already present or unsafe");
      expect(readFileSync(childOutside, "utf8")).toBe("keep");
    },
  );

  test("report creation and audit keep inputs symlinked and outputs independent", async () => {
    const root = tempRoot("visual-report-");
    const store = join(root, "user-inline-assets");
    const source = join(root, "source.png");
    await writeImage(source, 4, 4, () => [255, 255, 255, 255]);
    const now = new Date("2026-10-27T01:02:03.000Z");
    const expected = createSnapshot({
      source,
      cwd: resolve("."),
      storeRoot: store,
      now,
      rand8: "00000001",
    }).snapshot_path;
    const actual = createSnapshot({
      source,
      cwd: resolve("."),
      storeRoot: store,
      now,
      rand8: "00000002",
    }).snapshot_path;
    const fakeRunner = (directory: string) => {
      const actualName = readdirNames(join(directory, "actual"))[0] as string;
      writeFileSync(
        join(directory, "report.html"),
        `<html><div id="app"></div><script>window['__reg__'] = ${JSON.stringify({ actualDir: "./actual", expectedDir: "./expected", diffDir: "./diff", newItems: [], deletedItems: [], hasNew: false, hasDeleted: false, hasFailed: true, hasPassed: false, failedItems: [{ raw: actualName, encoded: actualName }], passedItems: [] })};</script><script>function renderReport(){ return 'rendered reg-cli application'; }</script></html>`,
      );
      writeFileSync(
        join(directory, "reg.json"),
        JSON.stringify({
          actualItems: [actualName],
          expectedItems: [actualName],
          failedItems: [actualName],
          passedItems: [],
          diffItems: [`${actualName.slice(0, -4)}.png`],
        }),
      );
      writeFileSync(
        join(directory, "diff", `${actualName.slice(0, -4)}.png`),
        "diff",
      );
      return undefined;
    };
    const result = createReport({
      pairs: [{ name: "page", expected, actual }],
      cwd: resolve("."),
      storeRoot: store,
      now,
      token: "00000001",
      runRegCli: fakeRunner,
      cloneFile: (from, to) => copyFileSync(from, to),
    });
    expect(auditReport(String(result.report_dir), store).status).toBe("ok");
    expect(
      lstatSync(
        join(String(result.report_dir), "actual", "page.png"),
      ).isSymbolicLink(),
    ).toBe(true);
    expect(
      lstatSync(join(String(result.report_dir), "report.html")).nlink,
    ).toBe(1);
    const manifestPath = join(String(result.report_dir), "manifest.json");
    const manifest = readFileSync(manifestPath, "utf8");
    writeFileSync(manifestPath, "null");
    expect(auditReport(String(result.report_dir), store).status).toBe("broken");
    writeFileSync(manifestPath, JSON.stringify({ pairs: [null] }));
    expect(auditReport(String(result.report_dir), store).status).toBe("broken");
    writeFileSync(manifestPath, manifest);
    if (!sandboxAvailable())
      expect(() =>
        createReport({
          pairs: [{ name: "page", expected, actual }],
          cwd: resolve("."),
          storeRoot: store,
          now,
          token: "00000002",
        }),
      ).toThrow("refusing to run unsandboxed");
  });
});

function readdirNames(path: string): string[] {
  return readdirSync(path);
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
