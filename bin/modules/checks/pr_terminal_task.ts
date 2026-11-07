import {
  cleanupProof,
  liveGate,
  localProof,
  merged,
  readyClaim,
  waitExhausted,
} from "./pr_terminal_support";
import { add, type TerminalState } from "./pr_terminal_state";

export function emitReadyClaim(
  state: TerminalState,
  line: number,
  message: string,
): void {
  if (
    readyClaim.test(message) &&
    (state.latestPr === "missing" || state.latestPr === "merged")
  )
    add(
      state.findings,
      "READY_CLAIM_WITHOUT_OPEN_PR",
      line,
      `pr_status=${state.latestPr}`,
    );
}

export function emitTaskComplete(
  state: TerminalState,
  line: number,
  message: string,
): void {
  const local = localProof.test(message) ? line : state.localProofLine;
  const gate = liveGate.test(message);
  if (gate && !waitExhausted.test(message) && state.gateKey !== message) {
    state.gateKey = message;
    add(
      state.findings,
      "ACTIVE_GATE_CLOSED_OUT_EARLY",
      line,
      "active review gate was closed before its proof finished",
    );
  }
  if (
    state.activeProofLine &&
    merged.test(message) &&
    !waitExhausted.test(message)
  )
    add(
      state.findings,
      "ACTIVE_GATE_CLOSED_OUT_EARLY",
      line,
      "active review proof was closed out after merge",
    );
  if (
    readyClaim.test(message) &&
    (state.latestPr === "missing" || state.latestPr === "merged")
  )
    add(
      state.findings,
      "READY_CLAIM_WITHOUT_OPEN_PR",
      line,
      `pr_status=${state.latestPr ?? "unknown"} ready_claim_line=${line}`,
    );
  if (
    state.fastTrackLine &&
    local &&
    (state.latestPr !== "exists" ||
      !state.currentHeadLine ||
      state.currentHeadLine < state.fastTrackLine)
  )
    add(
      state.findings,
      "FAST_TRACK_STOPPED_BEFORE_PR",
      line,
      `fast_track_line=${state.fastTrackLine} pr_status=${state.latestPr ?? "unknown"}`,
    );
  if (
    state.mergeIntentLine &&
    readyClaim.test(message) &&
    (!state.mergeCallLine || state.mergeCallLine < state.mergeIntentLine)
  )
    add(
      state.findings,
      "MERGE_INTENT_DROPPED_TO_PR_CONVERGENCE",
      line,
      `merge_intent_line=${state.mergeIntentLine} task_complete_line=${line}`,
    );
  if (
    state.mergeSuccessLine &&
    state.cleanupLine &&
    state.mergeCallLine >= state.cleanupLine &&
    !cleanupProof.test(message)
  )
    add(
      state.findings,
      "MERGE_CLEANUP_SKIPPED_AFTER_MERGE",
      line,
      `merge_cleanup_intent_line=${state.cleanupLine} merge_success_line=${state.mergeSuccessLine}`,
    );
  if (
    state.mergeIntentLine &&
    !state.cleanupLine &&
    state.mergeSuccessLine &&
    !state.deletedLine &&
    !state.deleteExemptionLine
  )
    add(
      state.findings,
      "REMOTE_BRANCH_NOT_DELETED_AFTER_MERGE",
      line,
      `merge_intent_line=${state.mergeIntentLine} merge_success_line=${state.mergeSuccessLine}`,
    );
  if (
    state.mergeIntentLine &&
    state.mergeSuccessLine &&
    state.baseBlockLine &&
    state.baseBlockLine > state.mergeSuccessLine &&
    !state.baseMenuLine &&
    !state.baseDecisionLine
  )
    add(
      state.findings,
      "BASE_UPDATE_DECISION_MENU_MISSING",
      line,
      `base_block_line=${state.baseBlockLine}`,
    );
  if (state.safeAlignLine && state.safeAlignRebaseLine === 0)
    add(
      state.findings,
      "SAFE_ALIGN_REBASE_MISSING",
      line,
      "safe alignment has no rebase action",
    );
  if (
    state.safeAlignLine &&
    state.safeAlignStashLine &&
    !state.safeAlignUntracked
  )
    add(
      state.findings,
      "SAFE_ALIGN_STASH_UNTRACKED_MISSING",
      line,
      "stash alignment omitted untracked files",
    );
  if (
    state.safeAlignLine &&
    state.safeAlignStashLine &&
    !state.safeAlignStashApplyLine &&
    !state.safeAlignStashPopLine
  )
    add(
      state.findings,
      "SAFE_ALIGN_STASH_NOT_REAPPLIED",
      line,
      "stash was not reapplied on the successful path",
    );
  if (state.safeAlignLine && state.safeAlignStashPopLine)
    add(
      state.findings,
      "SAFE_ALIGN_STASH_NOT_PRESERVED",
      line,
      "stash pop does not preserve a recoverable stash",
    );
  if (
    state.safeAlignLine &&
    (state.safeAlignStashLine || state.safeAlignRebaseLine) &&
    !state.safeAlignBackupLine
  )
    add(
      state.findings,
      "SAFE_ALIGN_BACKUP_BRANCH_MISSING",
      line,
      "safe alignment has no backup branch",
    );
}
