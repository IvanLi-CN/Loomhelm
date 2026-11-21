import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  currentBranch,
  inboundLinks,
  isProtectedBranch,
  isTopicSlug,
  legacyIdentity,
  parsePrefixedName,
  relativePath,
  type Json,
} from "./migration_common";

function regularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function baseResult(
  repoRoot: string,
  source: string,
  sourceRelative: string,
  topic: string,
  branch: string,
): Json {
  const targetRoot = `docs/specs/${topic}`;
  return {
    source: sourceRelative,
    topic,
    target_root: targetRoot,
    target_spec: `${targetRoot}/SPEC.md`,
    branch,
    write_allowed: !isProtectedBranch(branch),
    blocked_reason: null,
    inbound_links: inboundLinks(repoRoot, source, sourceRelative),
    pending_delete_approval: [],
  };
}

function withTopic(result: Json, topic: string): Json {
  if (isTopicSlug(topic)) return result;
  result.candidate_topic = topic;
  result.target_root = null;
  result.target_spec = null;
  result.required_topic_slug = "lowercase-kebab-case";
  result.blocked_reason = "topic_slug_required";
  return result;
}

export function planSpecsMigration(
  repoRootInput: string,
  sourceInput: string,
  options: { branch?: string; legacyId?: string; topic?: string } = {},
): Json {
  const repoRoot = resolve(repoRootInput);
  const source = resolve(sourceInput);
  const sourceRelative = relativePath(repoRoot, source);
  if (
    !regularFile(source) ||
    !sourceRelative.startsWith("docs/plan/") ||
    !source.endsWith("/PLAN.md")
  )
    throw new Error("source must be an existing docs/plan/**/PLAN.md file");
  const branch = options.branch ?? currentBranch(repoRoot);
  const identity = legacyIdentity(
    repoRoot,
    source.split("/").at(-2) ?? "",
    "docs/plan/README.md",
    sourceRelative,
    options.legacyId,
  );
  const topic =
    options.topic ?? identity?.[1] ?? source.split("/").at(-2) ?? "";
  const result = baseResult(repoRoot, source, sourceRelative, topic, branch);
  result.legacy_id = identity?.[0] ?? null;
  result.legacy_id_provenance = identity?.[2] ?? "none";
  withTopic(result, topic);
  if (result.blocked_reason) return result;
  if (isProtectedBranch(branch)) {
    result.blocked_reason = "protected_branch_read_only";
    return result;
  }
  if (existsSync(resolve(repoRoot, String(result.target_root)))) {
    result.blocked_reason = "slug_conflict";
    return result;
  }
  result.action = "create_slug_spec";
  result.pending_delete_approval = [sourceRelative];
  return result;
}

export function planSpecsHygiene(
  repoRootInput: string,
  legacyRootInput: string,
  options: {
    branch?: string;
    renameConfirmed?: boolean;
    legacyId?: string;
    topic?: string;
  } = {},
): Json {
  const repoRoot = resolve(repoRootInput);
  const legacyRoot = resolve(legacyRootInput);
  const sourceRelative = relativePath(repoRoot, legacyRoot);
  if (!directoryExists(legacyRoot) || !sourceRelative.startsWith("docs/specs/"))
    throw new Error(
      "source must be an existing docs/specs/<legacy-id>-<topic> directory",
    );
  const sourceSpecRelative = `${sourceRelative}/SPEC.md`;
  const identity = legacyIdentity(
    repoRoot,
    legacyRoot.split("/").at(-1) ?? "",
    "docs/specs/README.md",
    sourceSpecRelative,
    options.legacyId,
  );
  const topic =
    options.topic ?? identity?.[1] ?? legacyRoot.split("/").at(-1) ?? "";
  const branch = options.branch ?? currentBranch(repoRoot);
  const result = baseResult(
    repoRoot,
    legacyRoot,
    sourceRelative,
    topic,
    branch,
  );
  result.target_spec = `docs/specs/${topic}/SPEC.md`;
  result.legacy_root = sourceRelative;
  result.legacy_id = identity?.[0] ?? null;
  result.legacy_id_provenance = identity?.[2] ?? "none";
  if (!identity) {
    result.blocked_reason = parsePrefixedName(
      legacyRoot.split("/").at(-1) ?? "",
    )
      ? "legacy_id_proof_required"
      : "not_legacy_id_directory";
    return result;
  }
  withTopic(result, topic);
  if (result.blocked_reason) return result;
  if (isProtectedBranch(branch)) {
    result.blocked_reason = "protected_branch_read_only";
    return result;
  }
  if (existsSync(resolve(repoRoot, String(result.target_root)))) {
    result.blocked_reason = "slug_conflict";
    return result;
  }
  const conflicting: string[] = [];
  const specsRoot = resolve(repoRoot, "docs/specs");
  if (directoryExists(specsRoot)) {
    for (const entry of readdirSync(specsRoot, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name === (legacyRoot.split("/").at(-1) ?? "")
      )
        continue;
      const sibling = resolve(specsRoot, entry.name);
      const siblingRelative = relativePath(repoRoot, sibling);
      const siblingIdentity = legacyIdentity(
        repoRoot,
        entry.name,
        "docs/specs/README.md",
        `${siblingRelative}/SPEC.md`,
      );
      if (siblingIdentity?.[1] === topic) conflicting.push(siblingRelative);
    }
  }
  if (conflicting.length) {
    result.blocked_reason = "duplicate_slug_mapping";
    result.conflicting_legacy_roots = conflicting.sort();
    return result;
  }
  if (!options.renameConfirmed) {
    result.blocked_reason = "rename_confirmation_required";
    return result;
  }
  result.action = "git_mv";
  return result;
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
