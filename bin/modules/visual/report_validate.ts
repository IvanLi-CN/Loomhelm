import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import {
  expandUserPath,
  isIndependentRegularFile,
  isRealDirectory,
  isRegularFile,
} from "./paths";

export const SUPPORTED_SUFFIXES = new Set([".png", ".jpg", ".jpeg"]);
export const PAIR_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const REPORT_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export const SNAPSHOT_SCOPE = /^[a-z0-9]+(?:-[a-z0-9]+)*__[a-f0-9]{8}$/;
export const SNAPSHOT_FILENAME =
  /^\d{8}T\d{6}Z-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8}\.(?:png|jpe?g)$/;
export const REPORT_ROOT_ENTRIES = new Set([
  "actual",
  "expected",
  "diff",
  "report.html",
  "reg.json",
  "manifest.json",
]);

export type ImagePair = { name: string; expected: string; actual: string };
export type ManifestPair = {
  name: string;
  filename: string;
  expected_snapshot: string;
  expected_sha256: string;
  actual_snapshot: string;
  actual_sha256: string;
};
export type ItemLists = {
  actualItems: string[];
  expectedItems: string[];
  failedItems: string[];
  passedItems: string[];
  diffItems: string[];
};

function validUtcTimestamp(value: string): boolean {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(value);
  if (!match) return false;
  const parts = match.slice(1, 7).map(Number);
  const [year, month, day, hour, minute, second] = parts;
  const date = new Date(
    Date.UTC(
      year ?? NaN,
      (month ?? NaN) - 1,
      day ?? NaN,
      hour ?? NaN,
      minute ?? NaN,
      second ?? NaN,
    ),
  );
  return (
    !Number.isNaN(date.valueOf()) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === (month ?? NaN) - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

export function isDirectoryWithNames(
  directory: string,
  expected: Set<string>,
): boolean {
  try {
    const names = readdirSync(directory);
    return (
      names.length === expected.size &&
      names.every((name) => expected.has(name))
    );
  } catch {
    return false;
  }
}

export function snapshotPath(path: string, storeRoot: string): string {
  const expandedPath = expandUserPath(path);
  const expandedStoreRoot = expandUserPath(storeRoot);
  let resolved: string;
  try {
    resolved = realpathSync(expandedPath);
  } catch {
    throw new Error(
      `image must be an existing snapshot under ${storeRoot}: ${path}`,
    );
  }
  const rootPath = (() => {
    try {
      return realpathSync(expandedStoreRoot);
    } catch {
      return resolve(expandedStoreRoot);
    }
  })();
  const relativePath = relative(rootPath, resolved);
  if (relativePath.startsWith(".."))
    throw new Error(
      `image must be an existing snapshot under ${storeRoot}: ${path}`,
    );
  if (
    relativePath
      .split(/[\\/]/)
      .some((part) => part.toLocaleLowerCase() === "reg-cli-reports")
  )
    throw new Error("report outputs cannot be used as snapshot inputs");
  if (!isRegularFile(expandedPath) || lstatSync(expandedPath).isSymbolicLink())
    throw new Error(`image must be a regular snapshot file: ${path}`);
  const parts = relativePath.split(/[\\/]/);
  if (
    parts.length !== 5 ||
    !SNAPSHOT_SCOPE.test(parts[0] ?? "") ||
    !/^\d{4}$/.test(parts[1] ?? "") ||
    !/^\d{2}$/.test(parts[2] ?? "") ||
    !/^\d{2}$/.test(parts[3] ?? "") ||
    !validUtcTimestamp(parts[4] ?? "") ||
    !SNAPSHOT_FILENAME.test(parts[4] ?? "")
  )
    throw new Error("image must use the generated chat snapshot path layout");
  const filenameDate = (parts[4] ?? "").slice(0, 8);
  if (
    `${parts[1]}${parts[2]}${parts[3]}` !== filenameDate ||
    lstatSync(resolved).nlink !== 1
  )
    throw new Error(
      filenameDate !== `${parts[1]}${parts[2]}${parts[3]}`
        ? "snapshot filename timestamp does not match its date directory"
        : "snapshot inputs must not be hard-linked aliases",
    );
  return resolved;
}

export function validatePairs(
  pairs: ImagePair[],
  storeRoot: string,
): ImagePair[] {
  if (!pairs.length) throw new Error("at least one --pair is required");
  const seen = new Set<string>();
  return pairs.map((pair) => {
    if (!PAIR_NAME.test(pair.name) || pair.name === "." || pair.name === "..")
      throw new Error(`invalid pair name: ${pair.name}`);
    const normalized = pair.name.toLocaleLowerCase();
    if (seen.has(normalized))
      throw new Error(`duplicate pair name: ${pair.name}`);
    seen.add(normalized);
    const expected = snapshotPath(pair.expected, storeRoot);
    const actual = snapshotPath(pair.actual, storeRoot);
    if (
      extname(expected).toLowerCase() !== extname(actual).toLowerCase() ||
      !SUPPORTED_SUFFIXES.has(extname(actual).toLowerCase())
    )
      throw new Error(
        `pair ${pair.name} requires matching PNG or JPEG extensions`,
      );
    return { name: pair.name, expected, actual };
  });
}

export function containedDirectoryTree(path: string, root: string): string {
  const rootPath = resolve(root);
  const absolute = resolve(path);
  if (
    !isRealDirectory(rootPath) ||
    !relative(rootPath, absolute)
      .split(/[\\/]/)
      .every((part) => part !== ".." && !part.startsWith(".."))
  )
    throw new Error(
      `report directory must be under the snapshot store: ${absolute}`,
    );
  let current = rootPath;
  for (const part of relative(rootPath, absolute)
    .split(/[\\/]/)
    .filter(Boolean)) {
    current = join(current, part);
    if (!isRealDirectory(current)) {
      try {
        mkdirSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (!isRealDirectory(current))
      throw new Error(
        `report path component is not a regular directory: ${current}`,
      );
  }
  return absolute;
}

export function validReportFilename(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    basename(value) !== value ||
    value === "." ||
    value === ".."
  )
    return false;
  const suffix = extname(value).toLowerCase();
  return (
    SUPPORTED_SUFFIXES.has(suffix) &&
    PAIR_NAME.test(value.slice(0, -suffix.length))
  );
}

export function validatedItemLists(
  value: unknown,
  filenames: Set<string>,
): ItemLists {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("reg-cli produced invalid JSON");
  const record = value as Record<string, unknown>;
  for (const key of ["newItems", "deletedItems"])
    if (
      record[key] !== undefined &&
      (!Array.isArray(record[key]) || (record[key] as unknown[]).length)
    )
      throw new Error("reg-cli reported unexpected new or deleted items");
  const result = {} as ItemLists;
  for (const key of [
    "actualItems",
    "expectedItems",
    "failedItems",
    "passedItems",
    "diffItems",
  ] as const) {
    const items = record[key];
    if (
      !Array.isArray(items) ||
      items.some((item) => !validReportFilename(item)) ||
      new Set(items).size !== items.length
    )
      throw new Error("reg-cli produced invalid comparison items");
    result[key] = [...items] as string[];
  }
  if (
    new Set(result.actualItems).size !== filenames.size ||
    !result.actualItems.every((item) => filenames.has(item)) ||
    new Set(result.expectedItems).size !== filenames.size ||
    !result.expectedItems.every((item) => filenames.has(item))
  )
    throw new Error("reg-cli did not report every requested pair");
  if (
    new Set([...result.failedItems, ...result.passedItems]).size !==
      filenames.size ||
    result.failedItems.some(
      (item) => !filenames.has(item) || result.passedItems.includes(item),
    ) ||
    result.passedItems.some((item) => !filenames.has(item))
  )
    throw new Error("reg-cli could not compare every requested pair");
  const expectedDiff = new Set(
    result.failedItems.map(
      (item) => `${item.slice(0, item.lastIndexOf("."))}.png`,
    ),
  );
  if (
    expectedDiff.size !== result.diffItems.length ||
    result.diffItems.some((item) => !expectedDiff.has(item))
  )
    throw new Error(
      "reg-cli produced invalid diffItems for failed comparisons",
    );
  return result;
}

export function diffOutputIssue(
  directory: string,
  diffItems: string[],
  failedItems: string[],
): string | undefined {
  try {
    for (const entry of readdirSync(directory)) {
      if (!diffItems.includes(entry))
        return `unexpected diff artifact: ${entry}`;
      if (!isIndependentRegularFile(join(directory, entry)))
        return `unsafe diff artifact: ${entry}`;
    }
  } catch {
    return "cannot inspect diff directory";
  }
  for (const filename of new Set(
    failedItems.map((item) => `${item.slice(0, item.lastIndexOf("."))}.png`),
  ))
    if (!isIndependentRegularFile(join(directory, filename)))
      return `missing or unsafe diff image: ${filename}`;
  return undefined;
}
