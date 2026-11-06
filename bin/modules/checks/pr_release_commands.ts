import {
  add,
  releaseRerunAuthorizationMatches,
  type ReleaseState,
} from "./pr_release_state";
import { commandLabels, mutationTarget } from "./pr_release_routes";
import { rerun, routeMutation } from "./pr_release_rules";

function commandRepo(command: string): string | undefined {
  return command
    .match(/(?:^|\s)(?:-R|--repo)(?:=|\s+)(["']?[^\s;&|"']+)/i)?.[1]
    ?.replace(/^['"]|['"]$/g, "")
    .toLowerCase();
}

export function processReleaseCommand(
  state: ReleaseState,
  line: number,
  command: string,
): void {
  const mutation =
    routeMutation.test(command) &&
    !/git\s+push\s+[^\n]*(?:--delete|-d)\b/i.test(command);
  if (mutation) {
    state.routeMutationLines.push({ line, command });
    const mutationLabels = commandLabels(command);
    if (state.malformedPolicyRoute && mutationLabels.size && !state.route)
      add(
        state.findings,
        "RELEASE_LABEL_MUTATION_OUTSIDE_MANAGED_GROUP",
        line,
        "release-label mutation is outside the managed label group",
      );
    if (
      state.route &&
      !state.route.pr &&
      /\bgh\s+pr\s+create\b|code_hosting(?:\.(?:py|ts))?[^\n]*\bpr-create\b|\bgh\s+api\b[^\n]*\/pulls\b[^\n]*(?:POST|-X\s+POST|--method\s+POST)/i.test(
        command,
      )
    )
      state.nullRouteMutationLines.push(line);
    const target = mutationTarget(command);
    if (
      state.route &&
      ((target.repo && target.repo !== state.route.repo) ||
        (target.pr && state.route.pr && target.pr !== state.route.pr))
    )
      add(
        state.findings,
        "RELEASE_ROUTE_TARGET_MISMATCH",
        line,
        "publication command target differs from the resolved route",
      );
    if (
      mutationLabels.size &&
      state.route &&
      [...mutationLabels].some((label) => !state.route!.labels.has(label))
    )
      add(
        state.findings,
        "RELEASE_LABEL_MUTATION_OUTSIDE_MANAGED_GROUP",
        line,
        "release-label mutation is outside the managed label group",
      );
  }
  for (const match of command.matchAll(new RegExp(rerun.source, "gi"))) {
    state.rerunCount += 1;
    state.lastRerunLine = line;
    const runId = (match[1] ?? match[2])?.replace(/^['"]|['"]$/g, "");
    const repoFlag = commandRepo(command);
    const ciRepo =
      state.expected === undefined
        ? (state.prCiRuns.get(runId ?? "") ??
          state.targetCiRuns.get(runId ?? ""))
        : undefined;
    if (ciRepo !== undefined) {
      if (repoFlag && repoFlag !== ciRepo) state.rerunViolation ||= line;
      continue;
    }
    state.releaseRerunAttempted = true;
    const authorized = releaseRerunAuthorizationMatches(state, runId, repoFlag);
    if (!state.actualRunId || runId !== state.actualRunId || !authorized)
      state.rerunViolation ||= line;
    else state.userAuthorizedRerun = true;
    if (state.expected === undefined) state.rerunViolation ||= line;
  }
}
