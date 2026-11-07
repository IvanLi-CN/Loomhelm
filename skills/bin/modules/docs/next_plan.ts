import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  STATUS_DONE,
  STATUS_PARTIAL_PREFIX,
  STATUS_PENDING_DESIGN,
  STATUS_READY,
  STATUS_REDESIGN_PREFIX,
  STATUS_SKIPPED,
  STATUS_VOID,
  createdAt,
  detectRoot,
  noPick,
  relOrAbs,
  resolveCandidate,
  row,
  separator,
  statusRank,
  table,
  type Candidate,
  type Json,
} from "./next_plan_support";
export {
  STATUS_DONE,
  STATUS_PARTIAL_PREFIX,
  STATUS_PENDING_DESIGN,
  STATUS_READY,
  STATUS_REDESIGN_PREFIX,
  STATUS_SKIPPED,
  STATUS_VOID,
} from "./next_plan_support";

export function findNextPlan(repoRootInput = "."): Json {
  const root = resolve(repoRootInput);
  const detected = detectRoot(root);
  if (!detected)
    return {
      ok: false,
      reason: "missing_docs_specs_and_plan",
      expected_paths: [
        join(root, "docs/specs/README.md"),
        join(root, "docs/plan/README.md"),
      ],
    };
  const primaryReadme = join(detected.primary, "README.md");
  if (!existsSync(primaryReadme))
    return {
      ok: false,
      reason: "missing_specs_index_readme",
      path: primaryReadme,
      spec_root_mode: detected.mode,
    };
  let lines = readFileSync(primaryReadme, "utf8").split(/\r?\n/);
  let found = table(lines);
  if (!found)
    return {
      ok: false,
      reason: "index_table_not_found",
      path: primaryReadme,
      spec_root_mode: detected.mode,
    };
  let indexRoot = detected.primary;
  let indexSource = "primary";
  if (found.mode === "lifecycle" && detected.fallback) {
    const fallbackReadme = join(detected.fallback, "README.md");
    if (existsSync(fallbackReadme)) {
      const fallbackLines = readFileSync(fallbackReadme, "utf8").split(/\r?\n/);
      const fallbackTable = table(fallbackLines);
      if (fallbackTable?.mode === "status") {
        lines = fallbackLines;
        found = fallbackTable;
        indexRoot = detected.fallback;
        indexSource = "fallback_legacy_plan_queue";
      }
    }
  }
  if (found.mode === "lifecycle") {
    const lifecycles = lines
      .slice(found.start)
      .filter((line) => line.trimStart().startsWith("|"))
      .map((line) => row(line)[found.columns.lifecycle ?? -1])
      .filter((value): value is string => Boolean(value));
    return {
      ok: false,
      reason: "topic_spec_repo_has_no_task_queue",
      index_mode: "lifecycle",
      index_source: indexSource,
      lifecycles,
      spec_root: relOrAbs(root, indexRoot),
      spec_root_mode: detected.mode,
      index_path_column: found.pathLabel,
      next_action: "use_other_task_source",
    };
  }
  const idColumn = found.columns.id;
  const titleColumn = found.columns.title;
  const statusColumn = found.columns.status;
  const pathColumn = found.columns.path;
  if (
    idColumn === undefined ||
    titleColumn === undefined ||
    statusColumn === undefined ||
    pathColumn === undefined
  ) {
    return {
      ok: false,
      reason: "index_table_not_found",
      path: primaryReadme,
      spec_root_mode: detected.mode,
    };
  }
  const statuses: string[] = [];
  const candidates: Candidate[] = [];
  const unresolved: Json[] = [];
  for (const line of lines.slice(found.start)) {
    if (!line.trimStart().startsWith("|")) break;
    const cells = row(line);
    if (!cells.length || separator(cells)) continue;
    const max = Math.max(...Object.values(found.columns));
    if (cells.length <= max) continue;
    const id = cells[idColumn] ?? "";
    const title = cells[titleColumn] ?? "";
    const status = cells[statusColumn] ?? "";
    if (status) statuses.push(status);
    if (status !== STATUS_READY && !status.startsWith(STATUS_PARTIAL_PREFIX))
      continue;
    const resolved = resolveCandidate(
      root,
      id,
      cells[pathColumn] ?? "",
      detected.primary,
      detected.fallback,
    );
    if (!resolved.path) {
      unresolved.push({
        spec_id: id,
        plan_id: id,
        title,
        status,
        candidates: resolved.candidates,
      });
      continue;
    }
    candidates.push({
      id,
      title,
      status,
      path: resolved.path,
      createdAt: createdAt(root, resolved.path),
      rank: statusRank(status),
    });
  }
  if (unresolved.length)
    return {
      ok: false,
      reason: "spec_path_not_unique_or_missing",
      implementable_candidates: unresolved,
      spec_root: relOrAbs(root, detected.primary),
      spec_root_mode: detected.mode,
      index_path_column: found.pathLabel,
      index_mode: found.mode,
    };
  if (!candidates.length)
    return {
      ok: false,
      reason: noPick(statuses),
      statuses,
      spec_root: relOrAbs(root, indexRoot),
      spec_root_mode: detected.mode,
      index_mode: found.mode,
      index_source: indexSource,
    };
  candidates.sort(
    (left, right) =>
      left.rank - right.rank ||
      (left.createdAt === null ? 1 : 0) - (right.createdAt === null ? 1 : 0) ||
      (left.createdAt ?? "").localeCompare(right.createdAt ?? "") ||
      left.id.localeCompare(right.id),
  );
  const pick = candidates[0] as Candidate;
  return {
    ok: true,
    spec_id: pick.id,
    plan_id: pick.id,
    title: pick.title,
    status: pick.status,
    spec_path: pick.path,
    plan_path: pick.path,
    created_at: pick.createdAt,
    selection_mode: "status_then_git_created_at",
    spec_root: relOrAbs(root, indexRoot),
    spec_root_mode: detected.mode,
    index_path_column: found.pathLabel,
    index_mode: found.mode,
    index_source: indexSource,
    next_action: "implement",
    next: `implement ${pick.path}`,
  };
}
