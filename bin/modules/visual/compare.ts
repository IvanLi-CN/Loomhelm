import { lstatSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { posix, relative, resolve, sep } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  decodeImage,
  difference,
  differenceBoundingBox,
  heatmapImage,
  IMAGE_INPUT_MAX_BYTES,
  PYTHON_COMPARE_MAX_IMAGE_PIXELS,
  writePng,
  type RgbaImage,
} from "./image";
import { readRegularNoFollow } from "./secure_io";
import { isPlatformPathAlias } from "./paths";

export const IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
];

const GIT_BLOB_MAX_BUFFER = IMAGE_INPUT_MAX_BYTES;

export type CandidateImage = { destination: string; path: string };

export function hasSymlinkedAncestor(path: string, stopAt?: string): boolean {
  const absolute = resolve(path);
  const start = stopAt
    ? resolve(stopAt)
    : resolve(absolute.split(sep)[0] || sep);
  const delta = relative(start, absolute);
  if (delta.startsWith("..")) return false;
  let current = start;
  for (const component of delta.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function candidateStopRoot(
  path: string,
  repoRoot: string,
): string | undefined {
  const absolute = resolve(path);
  for (const root of [resolve(repoRoot), resolve(tmpdir())]) {
    const delta = relative(root, absolute);
    if (
      delta === "" ||
      (!delta.startsWith(`..${sep}`) &&
        delta !== ".." &&
        !delta.startsWith(sep))
    )
      return root;
  }
  return undefined;
}

export function openNoFollow(path: string, stopAt?: string): Buffer {
  return readRegularNoFollow(path, stopAt, undefined, IMAGE_INPUT_MAX_BYTES);
}

function readBounded(path: string): Buffer {
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size > IMAGE_INPUT_MAX_BYTES)
    throw new Error("file exceeds read limit");
  return readFileSync(path);
}

export async function loadImage(
  path: string,
  noFollow = false,
  stopAt?: string,
): Promise<RgbaImage> {
  const bytes = noFollow ? openNoFollow(path, stopAt) : readBounded(path);
  return decodeImage(bytes, {
    limitInputPixels: PYTHON_COMPARE_MAX_IMAGE_PIXELS,
  });
}

function gitBlob(
  baseSha: string,
  destination: string,
  repoRoot: string,
): { status: string; bytes?: Buffer; error?: string } {
  const object = `${baseSha}:${destination}`;
  try {
    const type = execFileSync("git", ["cat-file", "-t", object], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (type !== "blob")
      return {
        status: "base_unreadable",
        error: "base path is not a Git blob",
      };
    return {
      status: "available",
      bytes: execFileSync("git", ["show", object], {
        cwd: repoRoot,
        maxBuffer: GIT_BLOB_MAX_BUFFER,
      }),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/not a valid object name|invalid object name/i.test(detail))
      return { status: "base_unavailable", error: detail };
    if (
      /does not exist|exists on disk|not found|path .* does not exist/i.test(
        detail,
      )
    )
      return { status: "current-only" };
    return { status: "base_unavailable", error: detail };
  }
}

function normalizeDestination(raw: string): string {
  const value = raw.trim();
  if (!value || value.startsWith("/") || value.split("/").includes(".."))
    throw new Error("candidate destination must be repo-relative");
  const normalized = posix.normalize(value).replace(/\/+$/, "");
  if (
    !IMAGE_EXTENSIONS.some((extension) =>
      normalized.toLowerCase().endsWith(extension),
    )
  )
    throw new Error("candidate destination is not a supported image");
  return normalized;
}

function normalizeCandidatePath(raw: string): string {
  if (raw.trim().split(/[\\/]/).includes(".."))
    throw new Error("candidate path contains traversal");
  return resolve(raw);
}

async function compareImages(
  baseline: RgbaImage,
  candidate: RgbaImage,
  output: string,
  outputRoot: string,
): Promise<Record<string, unknown>> {
  const diff = difference(baseline, candidate);
  const values = diff.data;
  let changedPixels = 0;
  let maxChannelDelta = 0;
  let sum = 0;
  for (let offset = 0; offset < values.length; offset += 4) {
    const pixel = [
      values[offset] ?? 0,
      values[offset + 1] ?? 0,
      values[offset + 2] ?? 0,
      values[offset + 3] ?? 0,
    ];
    if (pixel.some((value) => value !== 0)) changedPixels += 1;
    maxChannelDelta = Math.max(maxChannelDelta, ...pixel);
    sum += pixel.reduce((total, value) => total + value, 0);
  }
  await writePng(output, heatmapImage(diff), outputRoot);
  return {
    status: "compared",
    baseline_size: [baseline.width, baseline.height],
    candidate_size: [candidate.width, candidate.height],
    canvas_size: [diff.width, diff.height],
    difference_bbox: differenceBoundingBox(diff),
    changed_pixel_count: changedPixels,
    max_channel_delta: maxChannelDelta,
    mean_channel_delta: values.length ? sum / values.length : 0,
    heatmap: output,
  };
}

function checkOutputDirectory(path: string): void {
  let current: string = sep;
  const components = resolve(path).split(sep).filter(Boolean);
  for (const [index, component] of components.entries()) {
    current = resolve(current, component);
    try {
      const metadata = lstatSync(current);
      if (
        metadata.isSymbolicLink() &&
        !(index === 0 && isPlatformPathAlias(current))
      )
        throw new Error("comparison output path must not contain symlinks");
      if (
        !metadata.isDirectory() &&
        !(metadata.isSymbolicLink() && index === 0)
      )
        throw new Error("comparison output path must be a directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function compareVisualEvidence(
  baseSha: string,
  candidates: Array<[string, string] | CandidateImage>,
  outputDir: string,
  repoRoot = process.cwd(),
): Promise<Record<string, unknown>> {
  const root = resolve(repoRoot);
  checkOutputDirectory(outputDir);
  await mkdir(outputDir, { recursive: true });
  checkOutputDirectory(outputDir);
  const outputRoot = resolve(outputDir);
  const normalized: CandidateImage[] = [];
  const errors: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    const candidate = Array.isArray(item)
      ? { destination: item[0], path: item[1] }
      : item;
    try {
      const destination = normalizeDestination(candidate.destination);
      if (seen.has(destination)) {
        errors.push({
          destination,
          status: "ambiguous_candidate_path",
          error: "duplicate destination",
        });
      } else {
        seen.add(destination);
        normalized.push({
          destination,
          path: normalizeCandidatePath(candidate.path),
        });
      }
    } catch (error) {
      errors.push({
        destination: candidate.destination,
        status: "candidate_unreadable",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const pairs: Record<string, unknown>[] = [];
  for (const [index, candidate] of normalized.entries()) {
    const pair: Record<string, unknown> = {
      index: index + 1,
      destination: candidate.destination,
      candidate: candidate.path,
    };
    const stopRoot = candidateStopRoot(candidate.path, root);
    if (
      hasSymlinkedAncestor(candidate.path, stopRoot) ||
      (() => {
        try {
          return (
            lstatSync(candidate.path).isSymbolicLink() ||
            !lstatSync(candidate.path).isFile()
          );
        } catch {
          return true;
        }
      })()
    ) {
      pairs.push({
        ...pair,
        status: "candidate_unreadable",
        error: "candidate is missing or symlinked",
      });
      continue;
    }
    const base = gitBlob(baseSha, candidate.destination, root);
    if (base.status === "current-only") {
      pairs.push({ ...pair, status: "current-only", baseline: null });
      continue;
    }
    if (base.status !== "available" || !base.bytes) {
      pairs.push({
        ...pair,
        status: "baseline_unreadable",
        baseline: candidate.destination,
        error: base.error ?? base.status,
      });
      continue;
    }
    let baseline: RgbaImage;
    try {
      baseline = await decodeImage(base.bytes, {
        limitInputPixels: PYTHON_COMPARE_MAX_IMAGE_PIXELS,
      });
    } catch (error) {
      pairs.push({
        ...pair,
        status: "baseline_unreadable",
        baseline: candidate.destination,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    try {
      const actual = await loadImage(candidate.path, true, stopRoot);
      pairs.push({
        ...pair,
        ...(await compareImages(
          baseline,
          actual,
          resolve(
            outputRoot,
            `pair-${String(index + 1).padStart(2, "0")}-heatmap.png`,
          ),
          outputRoot,
        )),
        baseline: candidate.destination,
      });
    } catch (error) {
      pairs.push({
        ...pair,
        status: "candidate_unreadable",
        baseline: candidate.destination,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  pairs.push(...errors);
  const statuses = new Set(pairs.map((pair) => pair.status));
  const status = [
    "baseline_unreadable",
    "candidate_unreadable",
    "base_unavailable",
    "ambiguous_candidate_path",
  ].some((value) => statuses.has(value))
    ? "comparison_unavailable"
    : statuses.has("current-only")
      ? "current-only"
      : "compared";
  return {
    base_sha: baseSha,
    repo_root: root,
    candidate_pairs: normalized.map(({ destination, path }) => ({
      destination,
      candidate: path,
    })),
    pairs,
    status,
    confirmation_required: status !== "compared",
  };
}
