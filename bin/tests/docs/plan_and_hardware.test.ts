import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  linkSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestExtract } from "../../modules/docs/hardware_ingest";
import { verifyDocLocks } from "../../modules/docs/hardware_locks";
import { findNextPlan } from "../../modules/docs/next_plan";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "docs-runtime-"));
  temporaryRoots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Koha Test"]);
  git(root, ["config", "user.email", "koha@example.com"]);
  return root;
}

function git(
  root: string,
  args: string[],
  env: Record<string, string> = {},
): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

function put(root: string, path: string, content: string | Uint8Array): string {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
  return target;
}

describe("next plan", () => {
  test("selects partial work before ready work and uses git creation time", () => {
    const root = repo();
    put(root, "docs/specs/a1111-old/SPEC.md", "# Old\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "old"], {
      GIT_AUTHOR_DATE: "2026-03-10T08:00:00+08:00",
      GIT_COMMITTER_DATE: "2026-03-10T08:00:00+08:00",
    });
    put(root, "docs/specs/b2222-partial/SPEC.md", "# Partial\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "partial"], {
      GIT_AUTHOR_DATE: "2026-03-11T08:00:00+08:00",
      GIT_COMMITTER_DATE: "2026-03-11T08:00:00+08:00",
    });
    put(
      root,
      "docs/specs/README.md",
      "| ID | Title | Status | Spec |\n| --- | --- | --- | --- |\n| a1111 | Old | 待实现 | `a1111-old/SPEC.md` |\n| b2222 | Partial | 部分完成（1/3） | `b2222-partial/SPEC.md` |\n",
    );
    const result = findNextPlan(root);
    expect(result.ok).toBe(true);
    expect(result.spec_id).toBe("b2222");
    expect(result.selection_mode).toBe("status_then_git_created_at");
  });

  test("falls back from a lifecycle catalog to the legacy plan queue", () => {
    const root = repo();
    put(root, "docs/specs/a1111-topic/SPEC.md", "# Topic\n");
    put(
      root,
      "docs/specs/README.md",
      "| ID | Title | Lifecycle | Spec |\n| --- | --- | --- | --- |\n| a1111 | Topic | active | `a1111-topic/SPEC.md` |\n",
    );
    put(
      root,
      "docs/plan/README.md",
      "| ID | Title | Status | Plan |\n| --- | --- | --- | --- |\n| a1111 | Topic implementation | 待实现 | `a1111-topic/PLAN.md` |\n",
    );
    const result = findNextPlan(root);
    expect(result.ok).toBe(true);
    expect(result.index_source).toBe("fallback_legacy_plan_queue");
    expect(result.spec_root).toBe("docs/plan");
  });
});

describe("hardware document ingestion and locks", () => {
  test("rejects traversal and linked MinerU inputs before writing", () => {
    const root = repo();
    const extract = join(root, "extract");
    mkdirSync(extract, { recursive: true });
    put(root, "extract/full.md", "# Generated\n");
    put(root, "extract/device_origin.pdf", "pdf\n");
    expect(() =>
      ingestExtract({
        extractPath: extract,
        destDir: join(root, "docs/datasheets"),
        slug: "../escape",
      }),
    ).toThrow(/slug/);
    const outside = join(root, "outside.md");
    writeFileSync(outside, "secret\n", "utf8");
    rmSync(join(extract, "full.md"));
    symlinkSync(outside, join(extract, "full.md"));
    expect(() =>
      ingestExtract({
        extractPath: extract,
        destDir: join(root, "docs/datasheets"),
        slug: "device",
      }),
    ).toThrow(/unsafe link|full\.md/);
    rmSync(join(extract, "full.md"));
    put(root, "extract/full.md", "# Generated\n");
    linkSync(join(extract, "device_origin.pdf"), join(extract, "copy.pdf"));
    expect(() =>
      ingestExtract({
        extractPath: extract,
        destDir: join(root, "docs/datasheets"),
        slug: "device",
      }),
    ).toThrow(/unsafe link|hardlink/);
  });

  test("stages MinerU output with rewritten assets and a verifiable lock", () => {
    const root = repo();
    const extract = join(root, "extract");
    mkdirSync(join(extract, "images"), { recursive: true });
    put(root, "extract/full.md", "![Figure](./images/figure.png)\n");
    put(root, "extract/chunk_origin.pdf", new Uint8Array([0, 1, 2, 3]));
    put(root, "extract/images/figure.png", new Uint8Array([4, 5]));
    put(root, "extract/metadata.json", "{}\n");
    const result = ingestExtract({
      extractPath: extract,
      destDir: join(root, "docs/datasheets"),
      docSubdir: "sensor",
      slug: "sensor",
      sourceUrl: "https://vendor.example/sensor.pdf",
      vendor: "Vendor",
      part: "SENSOR-1",
      docType: "datasheet",
      addHeader: true,
      keepMineruJson: true,
    });
    expect(readFileSync(result.markdown, "utf8")).toContain(
      "sensor.assets/images/figure.png",
    );
    expect(readFileSync(result.markdown, "utf8")).toContain("> Vendor: Vendor");
    expect(result.lock).toBeDefined();
    const lock = JSON.parse(
      readFileSync(result.lock as string, "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(lock)).toEqual([
      "artifacts",
      "generated_at_utc",
      "generator",
      "schema",
      "slug",
      "source",
    ]);
    expect(lock.generated_at_utc).toMatch(/^\d{4}-\d{2}-\d{2}T.*\+00:00$/);
    expect(lock.generator).toEqual({ tool: "ingest_mineru_extract.ts" });
    expect(
      verifyDocLocks(join(root, "docs/datasheets"), { checkPerms: false })
        .exitCode,
    ).toBe(0);
    expect(
      readFileSync(
        join(root, "docs/datasheets/sensor/sensor.assets/mineru/metadata.json"),
        "utf8",
      ),
    ).toBe("{}\n");
  });

  test("detects generated Markdown drift and strict missing PDFs", () => {
    const root = repo();
    const extract = join(root, "extract");
    mkdirSync(extract, { recursive: true });
    put(root, "extract/full.md", "# Generated\n");
    put(root, "extract/device_origin.pdf", "pdf\n");
    const destination = join(root, "docs/datasheets");
    ingestExtract({
      extractPath: extract,
      destDir: destination,
      slug: "device",
      lockGenerated: false,
    });
    writeFileSync(join(destination, "device.md"), "# Edited\n", "utf8");
    expect(verifyDocLocks(destination, { checkPerms: false }).errors).toBe(1);
    rmSync(join(destination, "device.pdf"));
    const strict = verifyDocLocks(destination, {
      checkPerms: false,
      strictPdf: true,
    });
    expect(strict.exitCode).toBe(1);
    expect(
      strict.lines.some((line) => line.includes("missing source PDF")),
    ).toBe(true);
  });
});
