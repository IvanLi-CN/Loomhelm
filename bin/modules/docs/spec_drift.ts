import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gitText, runGit } from "./git";
import {
  isImplementationPath,
  pathCountsAsSpecSync,
  requiredSpecFiles,
  resolveAssociatedSpecPath,
  specAllowsLegacyRelatedAdrsNone,
  sourceRequiresRelatedAdrs,
  specTargetFromChangedPath,
  validateRelatedAdrs,
  type DriftPathContext,
} from "./spec_drift_paths";
import {
  collectChanges,
  commitCoverage,
  evidence,
  frozenAdrCheck,
  normalizeRepoPath,
  relatedAdrTargets,
  resolveBase,
  result,
  strictCheck,
} from "./spec_drift_helpers";
import type { DriftResult } from "./spec_drift_types";
export type { DriftResult } from "./spec_drift_types";

export interface DriftOptions {
  repoRoot?: string;
  cwd?: string;
  baseRef?: string;
  specPaths?: string[];
  specFree?: boolean;
  env?: Record<string, string | undefined>;
}

function specPaths(options: DriftOptions): string[] {
  return options.specPaths ?? [];
}

export function runSpecDrift(options: DriftOptions = {}): DriftResult {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot =
    options.repoRoot ?? gitText(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (!repoRoot)
    return result(3, "未检查", "未检查", "未检查", "not in git repository");
  const baseRef = resolveBase(repoRoot, options.baseRef);
  if (!baseRef)
    return result(3, "未检查", "未检查", "未检查", "base ref not resolvable");
  if (runGit(repoRoot, ["merge-base", baseRef, "HEAD"]).exitCode !== 0)
    return result(
      3,
      "未检查",
      "未检查",
      "未检查",
      `no merge base between ${baseRef} and HEAD`,
    );
  const changes = collectChanges(repoRoot, baseRef);
  const context: DriftPathContext = {
    repoRoot,
    baseRef,
    changedFiles: changes.changed,
    deletedFiles: changes.deleted,
    renamePairs: changes.renames,
  };
  const requested = specPaths(options);
  const requestedNormalized = requested
    .map((path) => normalizeRepoPath(repoRoot, path))
    .filter((path): path is string => path !== null);
  const specFree =
    options.specFree || options.env?.SPEC_DISPOSITION === "not_needed";
  const frozenError = frozenAdrCheck(
    context,
    requestedNormalized,
    options.env?.ADR_REFS ?? process.env.ADR_REFS,
  );
  if (frozenError) return result(2, "阻断", "存在", "ADR_REFS", frozenError);
  if (!changes.changed.length)
    return result(0, "通过", "不存在", "未检查", "no changes in diff");
  const specChanges = changes.changed.filter(
    (path) => path.startsWith("docs/specs/") || path.startsWith("docs/plan/"),
  );
  const implementationChanged = changes.changed.some(isImplementationPath);
  if (specFree && specChanges.length)
    return result(
      2,
      "阻断",
      "存在",
      evidence(repoRoot, specChanges),
      "spec-free run touched spec files",
    );
  if (!implementationChanged) {
    const checked = new Set<string>();
    let incomplete = false;
    const incompleteEvidence: string[] = [];
    let relatedError: string | null = null;
    for (const changed of specChanges) {
      const target = specTargetFromChangedPath(changed);
      if (!target || checked.has(target)) continue;
      checked.add(target);
      const resolved = resolveAssociatedSpecPath(context, target);
      if (resolved === "ambiguous")
        return result(
          3,
          "未检查",
          "未检查",
          "未检查",
          "ambiguous legacy spec mapping; provide canonical --spec-path",
        );
      const normalized = resolved ?? target;
      for (const required of requiredSpecFiles(context, normalized))
        if (!existsSync(resolve(repoRoot, required))) {
          incomplete = true;
          incompleteEvidence.push(required);
        }
      const related = validateRelatedAdrs(
        context,
        normalized,
        sourceRequiresRelatedAdrs(context, changed, normalized),
        specAllowsLegacyRelatedAdrsNone(context, normalized),
      );
      if (!related.ok)
        relatedError = `invalid Related ADRs in ${normalized}: ${related.error}`;
      const strictError = strictCheck(repoRoot, normalized);
      if (strictError)
        return result(
          2,
          "阻断",
          "存在",
          evidence(repoRoot, [normalized]),
          strictError,
        );
    }
    for (const requestedPath of requestedNormalized) {
      const resolved = resolveAssociatedSpecPath(context, requestedPath);
      if (resolved === "ambiguous")
        return result(
          3,
          "未检查",
          "未检查",
          "未检查",
          "ambiguous legacy spec mapping; provide canonical --spec-path",
        );
      if (!resolved) continue;
      const related = validateRelatedAdrs(
        context,
        resolved,
        sourceRequiresRelatedAdrs(context, requestedPath, resolved),
        specAllowsLegacyRelatedAdrsNone(context, resolved),
      );
      if (!related.ok)
        relatedError = `invalid Related ADRs in ${resolved}: ${related.error}`;
    }
    for (const target of relatedAdrTargets(
      repoRoot,
      changes.changed.filter((path) => /^docs\/adr\//.test(path)),
    )) {
      const related = validateRelatedAdrs(context, target, false, false);
      if (!related.ok)
        relatedError = `invalid Related ADRs in ${target}: ${related.error}`;
    }
    if (incomplete)
      return result(
        2,
        "阻断",
        "存在",
        evidence(repoRoot, [...specChanges, ...incompleteEvidence]),
        "changed spec directories are incomplete",
      );
    if (relatedError)
      return result(
        2,
        "阻断",
        "存在",
        evidence(repoRoot, specChanges),
        relatedError,
      );
    return result(
      0,
      "通过",
      "不存在",
      specChanges.length ? evidence(repoRoot, specChanges) : "未检查",
      "docs/workflow-only changes",
    );
  }
  if (specFree && requestedNormalized.length === 0)
    return result(
      0,
      "通过",
      "不存在",
      "none(spec-free)",
      "spec-free run (spec_disposition=not_needed)",
    );
  if (requestedNormalized.length === 0)
    return result(
      3,
      "未检查",
      "未检查",
      specChanges.length ? evidence(repoRoot, specChanges) : "未检查",
      "impl changes found but no SPEC_PATHS provided",
    );
  const normalized: string[] = [];
  for (const relativeRequested of requestedNormalized) {
    const resolved = resolveAssociatedSpecPath(context, relativeRequested);
    if (resolved === "ambiguous")
      return result(
        3,
        "未检查",
        "未检查",
        "未检查",
        "ambiguous legacy spec mapping; provide canonical --spec-path",
      );
    if (resolved && !normalized.includes(resolved)) normalized.push(resolved);
  }
  if (!normalized.length)
    return result(
      3,
      "未检查",
      "未检查",
      "未检查",
      "no valid SPEC_PATHS after normalization",
    );
  const specEvidence: string[] = [];
  const worktreeSpec = new Set<string>();
  let incomplete = false;
  let tracked = false;
  let associatedDeleted = false;
  for (const spec of normalized) {
    const root = dirname(spec);
    for (const required of requiredSpecFiles(context, spec))
      if (!existsSync(resolve(repoRoot, required))) {
        incomplete = true;
        specEvidence.push(required);
      }
    for (const changed of changes.changed)
      if (pathCountsAsSpecSync(changed, root, spec)) {
        tracked = true;
        specEvidence.push(changed);
        if (changes.deleted.includes(changed) && changed === spec)
          associatedDeleted = true;
      }
    if (
      changes.worktreeChanged.some((path) =>
        pathCountsAsSpecSync(path, root, spec),
      )
    )
      worktreeSpec.add(spec);
    const related = validateRelatedAdrs(
      context,
      spec,
      sourceRequiresRelatedAdrs(context, spec, spec),
      specAllowsLegacyRelatedAdrsNone(context, spec),
    );
    if (!related.ok)
      return result(
        2,
        "阻断",
        "存在",
        evidence(repoRoot, [spec]),
        `invalid Related ADRs in ${spec}: ${related.error}`,
      );
    const strictError = strictCheck(repoRoot, spec);
    if (strictError)
      return result(2, "阻断", "存在", evidence(repoRoot, [spec]), strictError);
  }
  const validated = new Set(normalized);
  for (const changed of specChanges) {
    const target = specTargetFromChangedPath(changed);
    if (!target || validated.has(target)) continue;
    const related = validateRelatedAdrs(
      context,
      target,
      sourceRequiresRelatedAdrs(context, changed, target),
      specAllowsLegacyRelatedAdrsNone(context, target),
    );
    if (!related.ok)
      return result(
        2,
        "阻断",
        "存在",
        evidence(repoRoot, [target]),
        `invalid Related ADRs in ${target}: ${related.error}`,
      );
    validated.add(target);
  }
  for (const target of relatedAdrTargets(
    repoRoot,
    changes.changed.filter((path) => /^docs\/adr\//.test(path)),
  )) {
    const related = validateRelatedAdrs(
      context,
      target,
      false,
      specAllowsLegacyRelatedAdrsNone(context, target),
    );
    if (!related.ok)
      return result(
        2,
        "阻断",
        "存在",
        evidence(repoRoot, [target]),
        `invalid Related ADRs in ${target}: ${related.error}`,
      );
  }
  if (incomplete || associatedDeleted)
    return result(
      2,
      "阻断",
      "存在",
      evidence(repoRoot, specEvidence),
      associatedDeleted
        ? "associated spec was deleted"
        : "associated spec files are missing",
    );
  if (
    implementationChanged &&
    changes.worktreeChanged.some(isImplementationPath) &&
    worktreeSpec.size === 0
  )
    return result(
      2,
      "阻断",
      "存在",
      "未检查",
      "worktree implementation changes without associated spec sync",
    );
  if (!tracked && worktreeSpec.size === 0)
    return result(
      2,
      "阻断",
      "存在",
      "未检查",
      "implementation changes without spec sync",
    );
  const coverage = commitCoverage(context, normalized, worktreeSpec);
  if (coverage)
    return result(
      2,
      "阻断",
      "存在",
      evidence(repoRoot, specEvidence),
      coverage,
    );
  return result(
    0,
    "通过",
    "不存在",
    evidence(repoRoot, specEvidence),
    "associated spec updated with implementation changes",
  );
}

export function parseSpecDriftArgs(args: string[]): {
  options?: DriftOptions;
  help?: boolean;
  error?: string;
} {
  const options: DriftOptions = { specPaths: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base-ref") {
      const value = args[index + 1];
      if (!value) return { error: "missing value for --base-ref" };
      options.baseRef = value;
      index += 1;
      continue;
    }
    if (arg === "--spec-path") {
      const value = args[index + 1];
      if (!value) return { error: "missing value for --spec-path" };
      options.specPaths?.push(value);
      index += 1;
      continue;
    }
    if (arg === "--spec-free") {
      options.specFree = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") return { help: true };
    return { error: `unknown argument: ${arg}` };
  }
  return { options };
}

export const SPEC_DRIFT_USAGE =
  "Usage: spec_drift_check.ts [--base-ref <ref>] [--spec-path <path>]... [--spec-free]";
