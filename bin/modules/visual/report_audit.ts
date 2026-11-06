import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  containedPathWithoutSymlinks,
  defaultSnapshotRoot,
  expandUserPath,
  isIndependentRegularFile,
  isRealDirectory,
  isRegularFile,
  sha256FileSync,
} from "./paths";
import { htmlReportIssue, reportLayoutIssue } from "./report_artifacts";
import {
  diffOutputIssue,
  isDirectoryWithNames,
  snapshotPath,
  validReportFilename,
  validatedItemLists,
  type ManifestPair,
  PAIR_NAME,
  REPORT_ROOT_ENTRIES,
} from "./report_validate";

export function auditReport(
  inputDir: string,
  storeRoot?: string,
): Record<string, unknown> {
  let root: string;
  try {
    root = realpathSync(
      resolve(expandUserPath(storeRoot ?? defaultSnapshotRoot())),
    );
  } catch {
    return {
      report_dir: inputDir,
      status: "broken",
      issues: ["snapshot store is unavailable"],
    };
  }
  const requested = resolve(expandUserPath(inputDir));
  if (lstatSafe(requested)?.isSymbolicLink())
    return {
      report_dir: inputDir,
      status: "broken",
      issues: ["report directory must not be a symlink"],
    };
  const contained = containedPathWithoutSymlinks(requested, root);
  if (!contained)
    return {
      report_dir: inputDir,
      status: "broken",
      issues: ["report directory must be under the snapshot store"],
    };
  if (!isRealDirectory(contained))
    return {
      report_dir: contained,
      status: "broken",
      issues: ["report directory is not a regular directory"],
    };
  const reportDir = contained;
  const issues: string[] = [];
  if (!isDirectoryWithNames(reportDir, REPORT_ROOT_ENTRIES))
    issues.push("unexpected or missing top-level report artifacts");
  const manifestPath = join(reportDir, "manifest.json");
  if (!isIndependentRegularFile(manifestPath))
    return {
      report_dir: reportDir,
      status: "broken",
      issues: ["missing or unsafe manifest file"],
    };
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("manifest is not an object");
    manifest = parsed as Record<string, unknown>;
  } catch {
    return {
      report_dir: reportDir,
      status: "broken",
      issues: ["invalid manifest JSON"],
    };
  }
  if (!Array.isArray(manifest.pairs) || !manifest.pairs.length)
    return {
      report_dir: reportDir,
      status: "broken",
      issues: ["invalid manifest pairs"],
    };
  const layout = reportLayoutIssue(reportDir, root, manifest);
  if (layout)
    return { report_dir: reportDir, status: "broken", issues: [layout] };
  const filenames = new Set<string>();
  const pairs: ManifestPair[] = [];
  for (const value of manifest.pairs) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push("invalid manifest filename");
      continue;
    }
    const pair = value as Partial<ManifestPair>;
    const suffix =
      typeof pair.filename === "string"
        ? pair.filename.slice(pair.filename.lastIndexOf("."))
        : "";
    if (
      typeof pair.name !== "string" ||
      !PAIR_NAME.test(pair.name) ||
      !validReportFilename(pair.filename) ||
      pair.filename !== `${pair.name}${suffix}` ||
      filenames.has(pair.filename)
    ) {
      issues.push("invalid manifest filename");
      continue;
    }
    filenames.add(pair.filename);
    pairs.push(pair as ManifestPair);
    for (const [folder, key, hashKey] of [
      ["actual", "actual_snapshot", "actual_sha256"],
      ["expected", "expected_snapshot", "expected_sha256"],
    ] as const) {
      const source = typeof pair[key] === "string" ? (pair[key] as string) : "";
      const expectedHash =
        typeof pair[hashKey] === "string" ? (pair[hashKey] as string) : "";
      const link = join(reportDir, folder, pair.filename);
      const sourcePath = source
        ? containedPathWithoutSymlinks(source, root)
        : null;
      if (
        !isRealDirectory(join(reportDir, folder)) ||
        !source ||
        !isAbsolute(source) ||
        !/^[a-f0-9]{64}$/.test(expectedHash)
      ) {
        issues.push(`invalid ${folder} dependency metadata: ${pair.filename}`);
        continue;
      }
      if (!sourcePath) {
        issues.push(`snapshot is missing or outside the store: ${source}`);
        continue;
      }
      if (!isRegularFile(sourcePath)) {
        issues.push(`snapshot is missing or not a regular file: ${sourcePath}`);
        continue;
      }
      try {
        snapshotPath(sourcePath, root);
      } catch {
        issues.push(
          `snapshot is not an independent generated chat snapshot: ${sourcePath}`,
        );
        continue;
      }
      const linkTarget = realpathSafe(link);
      if (!lstatSafe(link)?.isSymbolicLink() || linkTarget !== sourcePath)
        issues.push(`missing or changed dependency: ${link} -> ${sourcePath}`);
      else if (sha256FileSync(sourcePath) !== expectedHash)
        issues.push(`modified snapshot: ${sourcePath}`);
    }
  }
  for (const folder of ["actual", "expected"])
    if (!isRealDirectory(join(reportDir, folder)))
      issues.push(`missing or unsafe snapshot directory: ${folder}`);
    else if (!isDirectoryWithNames(join(reportDir, folder), filenames))
      issues.push(`unexpected or missing snapshot entries: ${folder}`);
  for (const file of ["report.html", "reg.json"])
    if (!isIndependentRegularFile(join(reportDir, file)))
      issues.push(`missing or unsafe report file: ${file}`);
  const diff = join(reportDir, "diff");
  if (!isRealDirectory(diff)) issues.push("missing or unsafe diff directory");
  if (
    isIndependentRegularFile(join(reportDir, "reg.json")) &&
    isRealDirectory(diff)
  ) {
    try {
      const items = validatedItemLists(
        JSON.parse(readFileSync(join(reportDir, "reg.json"), "utf8")),
        filenames,
      );
      if (isIndependentRegularFile(join(reportDir, "report.html"))) {
        const html = htmlReportIssue(join(reportDir, "report.html"), items);
        if (html) issues.push(html);
      }
      const diffIssue = diffOutputIssue(
        diff,
        items.diffItems,
        items.failedItems,
      );
      if (diffIssue) issues.push(diffIssue);
    } catch {
      issues.push("invalid comparison items");
    }
  }
  return {
    report_dir: reportDir,
    status: issues.length ? "broken" : "ok",
    issues,
  };
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return "";
  }
}

function lstatSafe(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}
