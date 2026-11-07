import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, relative, resolve } from "node:path";
import {
  cloneReportFile,
  identity,
  removeStagingPath,
  type FileIdentity,
  REG_CLI_COMMAND,
} from "./isolation";
import { renameNoReplace } from "./secure_io";
import {
  defaultSnapshotRoot,
  containedPathWithoutSymlinks,
  expandUserPath,
  formatUtcTimestamp,
  isIndependentRegularFile,
  isRealDirectory,
  isRegularFile,
  pathWithin,
  repoScope,
  sha256FileSync,
} from "./paths";
import {
  cloneReportOutputs,
  htmlReportIssue,
  snapshotIntegrityIssue,
} from "./report_artifacts";
import {
  containedDirectoryTree,
  diffOutputIssue,
  isDirectoryWithNames,
  validatePairs,
  validatedItemLists,
  type ImagePair,
  type ManifestPair,
  REPORT_ROOT_ENTRIES,
  REPORT_TOKEN,
} from "./report_validate";
import { runRegCli, type CloneFile, type RunRegCli } from "./report_runtime";

function pathIdentityIntact(
  path: string,
  root: string,
  original: FileIdentity,
): boolean {
  try {
    const current = identity(path);
    return (
      lstatSync(path).isDirectory() &&
      current.dev === original.dev &&
      current.ino === original.ino &&
      containedPathWithoutSymlinks(path, root) === resolve(path)
    );
  } catch {
    return false;
  }
}

function cryptoToken(): string {
  return randomBytes(8).toString("hex");
}

function sealStaging(
  staging: string,
  parent: string,
  root: string,
  original: FileIdentity,
): string {
  if (!pathIdentityIntact(staging, root, original))
    throw new Error("reg-cli replaced or moved the staging directory");
  const sealed = join(parent, `.sealed-report-${cryptoToken()}`);
  renameSync(staging, sealed);
  return sealed;
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return "";
  }
}

function populatePublicationStage(
  source: string,
  publication: string,
  root: string,
  pairs: ManifestPair[],
  clone: CloneFile,
): void {
  if (
    !isDirectoryWithNames(
      source,
      new Set(
        [...REPORT_ROOT_ENTRIES].filter((name) => name !== "manifest.json"),
      ),
    )
  )
    throw new Error("reg-cli produced unexpected top-level report artifacts");
  if (
    !["actual", "expected", "diff"].every((folder) =>
      isRealDirectory(join(source, folder)),
    )
  )
    throw new Error("reg-cli replaced an input or diff directory");
  if (
    !isIndependentRegularFile(join(source, "report.html")) ||
    !isIndependentRegularFile(join(source, "reg.json"))
  )
    throw new Error("reg-cli outputs must be independent regular files");
  const filenames = new Set(pairs.map((pair) => pair.filename));
  for (const folder of ["actual", "expected"])
    if (!isDirectoryWithNames(join(source, folder), filenames))
      throw new Error(`reg-cli changed or added snapshot inputs in ${folder}`);
  for (const pair of pairs)
    for (const [folder, key] of [
      ["actual", "actual_snapshot"],
      ["expected", "expected_snapshot"],
    ] as const) {
      const link = join(source, folder, pair.filename);
      if (
        !lstatSync(link).isSymbolicLink() ||
        realpathSafe(link) !== resolve(pair[key])
      )
        throw new Error("reg-cli changed an input snapshot link");
    }
  const integrity = snapshotIntegrityIssue(pairs, root);
  if (integrity) throw new Error(integrity);
  mkdirSync(join(publication, "diff"));
  const regJson = JSON.parse(
    readFileSync(join(source, "reg.json"), "utf8"),
  ) as unknown;
  const items = validatedItemLists(regJson, filenames);
  const diffIssue = diffOutputIssue(
    join(source, "diff"),
    items.diffItems,
    items.failedItems,
  );
  if (diffIssue) throw new Error(diffIssue);
  cloneReportOutputs(source, publication, items, clone);
  let publishedItems: ReturnType<typeof validatedItemLists>;
  try {
    publishedItems = validatedItemLists(
      JSON.parse(readFileSync(join(publication, "reg.json"), "utf8")),
      filenames,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("reg-cli"))
      throw error;
    throw new Error("published reg-cli JSON is invalid");
  }
  const publishedDiffIssue = diffOutputIssue(
    join(publication, "diff"),
    publishedItems.diffItems,
    publishedItems.failedItems,
  );
  if (publishedDiffIssue) throw new Error(publishedDiffIssue);
  for (const folder of ["actual", "expected"])
    mkdirSync(join(publication, folder));
  for (const pair of pairs)
    for (const [folder, key] of [
      ["actual", "actual_snapshot"],
      ["expected", "expected_snapshot"],
    ] as const) {
      const sourceImage = resolve(pair[key]);
      if (
        containedPathWithoutSymlinks(sourceImage, root) !== sourceImage ||
        !isRegularFile(sourceImage)
      )
        throw new Error("snapshot input disappeared or escaped the asset root");
      const link = join(publication, folder, pair.filename);
      symlinkSync(relative(resolve(publication, folder), sourceImage), link);
    }
  if (
    !["actual", "expected"].every((folder) =>
      isDirectoryWithNames(join(publication, folder), filenames),
    )
  )
    throw new Error("published snapshot links are incomplete");
  const htmlIssue = htmlReportIssue(
    join(publication, "report.html"),
    publishedItems,
  );
  if (htmlIssue) throw new Error(htmlIssue);
  const finalDiffIssue = diffOutputIssue(
    join(publication, "diff"),
    publishedItems.diffItems,
    publishedItems.failedItems,
  );
  if (finalDiffIssue) throw new Error(finalDiffIssue);
}

export function createReport(options: {
  pairs: ImagePair[];
  cwd: string;
  storeRoot?: string;
  now?: Date;
  token?: string;
  runRegCli?: RunRegCli;
  cloneFile?: CloneFile;
  beforePublish?: () => void;
}): Record<string, unknown> {
  const root = realpathSync(
    resolve(expandUserPath(options.storeRoot ?? defaultSnapshotRoot())),
  );
  const checked = validatePairs(options.pairs, root);
  const timestamp = options.now ?? new Date();
  const token = options.token ?? cryptoToken().slice(0, 8);
  if (!REPORT_TOKEN.test(token))
    throw new Error("report token must be a single safe path component");
  const scope = repoScope(resolve(expandUserPath(options.cwd))).repoScope;
  const date = formatUtcTimestamp(timestamp);
  const parent = containedDirectoryTree(
    join(
      root,
      scope,
      date.slice(0, 4),
      date.slice(4, 6),
      date.slice(6, 8),
      "reg-cli-reports",
    ),
    root,
  );
  const reportDir = join(parent, `${date}-${token}`);
  if (existsSync(reportDir))
    throw new Error(`report already exists: ${reportDir}`);
  const staging = mkdtempSync(join(parent, ".report-"));
  const stagingIdentity = identity(staging);
  const runner = options.runRegCli ?? runRegCli;
  const clone = options.cloneFile ?? cloneReportFile;
  let sealed: string | undefined;
  let publication: string | undefined;
  let publicationIdentity: FileIdentity | undefined;
  let committed = false;
  try {
    for (const folder of ["actual", "expected", "diff"])
      mkdirSync(join(staging, folder));
    const manifestPairs: ManifestPair[] = checked.map((pair) => {
      const filename = `${pair.name}${pair.actual.slice(pair.actual.lastIndexOf("."))}`;
      symlinkSync(
        relative(join(staging, "actual"), pair.actual),
        join(staging, "actual", filename),
      );
      symlinkSync(
        relative(join(staging, "expected"), pair.expected),
        join(staging, "expected", filename),
      );
      return {
        name: pair.name,
        filename,
        expected_snapshot: pair.expected,
        expected_sha256: sha256FileSync(pair.expected),
        actual_snapshot: pair.actual,
        actual_sha256: sha256FileSync(pair.actual),
      };
    });
    const runtime = runner(staging, REG_CLI_COMMAND);
    sealed = sealStaging(staging, parent, root, stagingIdentity);
    if (runtime)
      removeStagingPath(
        join(sealed, runtime.runtimeName),
        runtime.runtimeIdentity,
      );
    if (!pathIdentityIntact(sealed, root, stagingIdentity))
      throw new Error("reg-cli replaced or moved the staging directory");
    publication = mkdtempSync(join(parent, ".publication-"));
    publicationIdentity = identity(publication);
    populatePublicationStage(sealed, publication, root, manifestPairs, clone);
    const manifest = {
      created_at_utc: timestamp.toISOString(),
      repo_scope: scope,
      pairs: manifestPairs,
      generated_files: ["report.html", "reg.json", "diff/"],
    };
    writeFileSync(
      join(publication, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    if (
      !isDirectoryWithNames(publication, REPORT_ROOT_ENTRIES) ||
      !pathIdentityIntact(publication, root, publicationIdentity) ||
      !isRealDirectory(parent) ||
      !containedPathWithoutSymlinks(parent, root) ||
      !pathWithin(root, reportDir)
    )
      throw new Error(
        "report path contains a symlink or escapes the snapshot store",
      );
    const issue = snapshotIntegrityIssue(manifestPairs, root);
    if (issue) throw new Error(issue);
    options.beforePublish?.();
    renameNoReplace(publication, reportDir, root);
    const afterIssue = snapshotIntegrityIssue(manifestPairs, root);
    if (afterIssue) throw new Error(afterIssue);
    committed = true;
    return {
      report_html: join(reportDir, "report.html"),
      report_dir: reportDir,
      pairs: checked.length,
    };
  } finally {
    if (!committed && publication && publicationIdentity)
      removeStagingPath(publication, publicationIdentity);
    if (!committed && existsSync(reportDir) && publicationIdentity)
      removeStagingPath(reportDir, publicationIdentity);
    if (sealed) removeStagingPath(sealed, stagingIdentity);
    if (existsSync(staging)) removeStagingPath(staging, stagingIdentity);
  }
}
