import { finding, isRecord, type Finding, type JsonRecord } from "./replay";
import {
  hasBoundStructuredMergedFact,
  type ReleaseRouteState,
} from "./flow_release";

const cleanupStop =
  /merge\+cleanup|收工条件=.*merge\+cleanup|当前 stop condition 是 .*merge\+cleanup/i;
const mergeRoute =
  /skills\/project-engineering-workflow\/references\/pr-merge-procedure\.md|\$pr-merge\b|PR merge procedure/i;
const cleanupRoute = /skills\/git-cleanup\/SKILL\.md|\$git-cleanup\b/i;
const mergedText = /PR 已 merged|PR 已合并|结果=已合并|Merged pull request/i;
const unresolved =
  /后续追踪\s*=\s*(?:unchecked|blocked)|发布状态\s*[:=]\s*(?:运行中|未终态|未检查)/i;
const cleanupProof = /cleanup_proof\s*=\s*([^\s`，。；;,]+)/gi;
const nonpositiveProofs = new Set([
  "unchecked",
  "unknown",
  "none",
  "pending",
  "later",
  "future",
  "blocked",
  "未检查",
  "稍后生成",
]);

type CleanupEvent = { line: number; kind: "positive" | "nonpositive" };

export interface FlowCleanupState {
  mergedLine: number;
  cleanupStopLine: number;
  unresolvedLine: number;
  cleanupEvents: CleanupEvent[];
  prMergeRouteLines: number[];
  gitCleanupRouteLines: number[];
}

export function createFlowCleanupState(): FlowCleanupState {
  return {
    mergedLine: 0,
    cleanupStopLine: 0,
    unresolvedLine: 0,
    cleanupEvents: [],
    prMergeRouteLines: [],
    gitCleanupRouteLines: [],
  };
}

export function updateFlowCleanupState(
  state: FlowCleanupState,
  releaseRouteState: ReleaseRouteState,
  value: JsonRecord,
  kind: string | undefined,
  role: string | undefined,
  joined: string,
  line: number,
): number {
  if (
    kind === "function_call_output" &&
    hasBoundStructuredMergedFact(releaseRouteState, value)
  )
    state.mergedLine = line;
  const taskComplete =
    value.type === "event_msg" &&
    isRecord(value.payload) &&
    value.payload.type === "task_complete";
  if (role === "assistant" || role === "user") {
    if (!state.cleanupStopLine && cleanupStop.test(joined))
      state.cleanupStopLine = line;
    let positiveProof = false;
    let nonpositiveProof = false;
    for (const match of joined.matchAll(cleanupProof)) {
      const value = match[1]!
        .trim()
        .replace(/[，。；;,.]+$/g, "")
        .toLowerCase();
      if (nonpositiveProofs.has(value)) nonpositiveProof = true;
      else if (value) positiveProof = true;
    }
    if (positiveProof || nonpositiveProof) {
      state.cleanupEvents.push({
        line,
        kind: positiveProof ? "positive" : "nonpositive",
      });
    }
    if (!state.unresolvedLine && unresolved.test(joined))
      state.unresolvedLine = line;
    if (!state.mergedLine && mergedText.test(joined)) state.mergedLine = line;
  }
  if (!state.mergedLine && taskComplete && mergedText.test(joined))
    state.mergedLine = line;
  if (kind === "function_call" && mergeRoute.test(joined))
    state.prMergeRouteLines.push(line);
  if (kind === "function_call" && cleanupRoute.test(joined))
    state.gitCleanupRouteLines.push(line);
  return state.mergedLine;
}

export function flowCleanupFindings(state: FlowCleanupState): Finding[] {
  const findings: Finding[] = [];
  let rerunCleanup: { line: number; proof: CleanupEvent } | undefined;
  for (const routeLine of state.gitCleanupRouteLines) {
    let latestProof: CleanupEvent | undefined;
    for (const event of state.cleanupEvents)
      if (event.line < routeLine) latestProof = event;
    if (
      state.cleanupStopLine &&
      state.mergedLine &&
      state.unresolvedLine &&
      state.unresolvedLine < routeLine &&
      latestProof?.kind === "positive"
    ) {
      rerunCleanup = { line: routeLine, proof: latestProof };
      break;
    }
  }
  if (rerunCleanup)
    findings.push(
      finding(
        "MERGE_CLEANUP_STEP6_RERUNS_CLEANUP",
        rerunCleanup.line,
        `merge_cleanup_stop_line=${state.cleanupStopLine} merged_line=${state.mergedLine} cleanup_proof_line=${rerunCleanup.proof.line} followup_unresolved_line=${state.unresolvedLine} git_cleanup_route_line=${rerunCleanup.line} pr_merge_route_line=${state.prMergeRouteLines[0] ?? "-"}`,
      ),
    );

  let skipsCleanup: { line: number; proof: CleanupEvent } | undefined;
  for (const routeLine of state.prMergeRouteLines) {
    let latestProof: CleanupEvent | undefined;
    for (const event of state.cleanupEvents)
      if (event.line < routeLine) latestProof = event;
    if (
      state.cleanupStopLine &&
      state.mergedLine &&
      state.unresolvedLine &&
      state.unresolvedLine < routeLine &&
      latestProof?.kind === "nonpositive"
    ) {
      skipsCleanup = { line: routeLine, proof: latestProof };
      break;
    }
  }
  if (skipsCleanup)
    findings.push(
      finding(
        "MERGE_CLEANUP_STEP6_SKIPS_CLEANUP_WITH_NONPOSITIVE_PROOF",
        skipsCleanup.line,
        `merge_cleanup_stop_line=${state.cleanupStopLine} merged_line=${state.mergedLine} nonpositive_cleanup_proof_line=${skipsCleanup.proof.line} followup_unresolved_line=${state.unresolvedLine} pr_merge_route_line=${skipsCleanup.line} git_cleanup_route_line=${state.gitCleanupRouteLines[0] ?? "-"}`,
      ),
    );
  return findings;
}
