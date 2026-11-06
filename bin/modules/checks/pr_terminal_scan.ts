import { eventTexts, readJsonLines } from "./replay";
import { isNestedTaskFlow } from "./flow_support";
import {
  activeProof,
  baseBlocked,
  baseDecision,
  baseMenu,
  baseUpdated,
  cleanupIntent,
  deleteExempt,
  deleteProof,
  flowLock,
  flowType,
  headBranch,
  localProof,
  mergeOnlyIntent,
  merged,
  prExists,
  prMissing,
  readyIntent,
  safeAlign,
  writableAuth,
  freshnessAuth,
  isTaskComplete,
  payloadOf,
  taskMessage,
  updateCurrentHead,
  canonicalFlowType,
} from "./pr_terminal_support";
import { add, type TerminalState } from "./pr_terminal_state";
import { emitReadyClaim, emitTaskComplete } from "./pr_terminal_task";
import {
  processTerminalCommand,
  processTerminalOutput,
} from "./pr_terminal_events";

export function scanTerminal(state: TerminalState, path: string): void {
  for (const { line, value } of readJsonLines(path)) {
    const payload = payloadOf(value);
    const { kind, role, texts } = eventTexts(value);
    const joined = texts.join("\n");
    const task = taskMessage(value);
    const text = task || joined;
    const typeMatch = role ? flowType.exec(joined) : null;
    if (typeMatch) {
      const nextFlow = canonicalFlowType(typeMatch[1]!);
      const nestedTaskFlow = isNestedTaskFlow(
        state.parentFlow,
        nextFlow,
        role,
        joined,
      );
      if (nestedTaskFlow) {
        state.taskFlow = nextFlow;
        state.taskLock = "";
      } else {
        state.parentFlow = nextFlow;
        state.parentLock = "";
        state.taskFlow = "";
        state.taskLock = "";
      }
      state.fastTrackLine = 0;
      state.latestPr = undefined;
      state.currentHeadLine = 0;
    }
    const lockMatch = role ? flowLock.exec(joined) : null;
    if (lockMatch) {
      if (state.parentFlow === "multi-task-flow" && state.taskFlow)
        state.taskLock = lockMatch[1]!.toLowerCase();
      else state.parentLock = lockMatch[1]!.toLowerCase();
    }
    const activeFlow =
      state.parentFlow === "multi-task-flow" && state.taskFlow
        ? state.taskFlow
        : state.parentFlow;
    const activeLock =
      state.parentFlow === "multi-task-flow" && state.taskFlow
        ? state.taskLock
        : state.parentLock;
    if (
      ["fast-track", "multi-task-flow"].includes(activeFlow) &&
      activeLock === "locked" &&
      !state.fastTrackLine
    )
      state.fastTrackLine = line;
    else if (role && (typeMatch || lockMatch)) state.fastTrackLine = 0;
    if (prExists.test(joined) && !prMissing.test(joined))
      state.latestPr = "exists";
    if (prMissing.test(joined) && !/远端分支|remote branch/i.test(joined)) {
      state.latestPr = "missing";
      state.currentHeadLine = 0;
    }
    updateCurrentHead(state, line, joined);
    if (merged.test(joined)) {
      state.latestPr = "merged";
      state.currentHeadLine = 0;
    }
    if (role === "assistant" && localProof.test(joined))
      state.localProofLine = line;
    if (role === "assistant" && activeProof.test(joined)) {
      state.activeProofIntentLine = line;
      if (state.activeReviewSessions.size) {
        state.activeProofLine = line;
        for (const session of state.activeReviewSessions)
          state.activeProofSessions.add(session);
      }
    }
    if (role === "user" && safeAlign.test(joined)) state.safeAlignLine ||= line;
    if (role === "user") {
      const hasCleanupIntent =
        cleanupIntent.test(joined) && !mergeOnlyIntent.test(joined);
      if (
        (readyIntent.test(joined) || /准备好\s*PR/i.test(joined)) &&
        !hasCleanupIntent
      )
        state.mergeIntentLine = 0;
      else if (hasCleanupIntent) {
        state.cleanupLine = line;
        state.mergeIntentLine = line;
      } else if (mergeOnlyIntent.test(joined)) state.mergeIntentLine = line;
    } else if (role === "assistant") {
      if (
        /(?:stop condition|收工条件|Fast-track stop condition|当前 stop condition)[^\n]*(?:merge\+cleanup|merge\s+and\s+cleanup|合并并收尾)/i.test(
          joined,
        )
      ) {
        state.cleanupLine = line;
        state.mergeIntentLine = line;
      } else if (
        /(?:stop condition|收工条件|当前 stop condition)[^\n]*merge-only/i.test(
          joined,
        )
      )
        state.mergeIntentLine = line;
    }
    if (
      (baseBlocked.test(joined) || baseUpdated.test(joined)) &&
      /ahead|behind|diverged|分叉|dirty|脏|未提交|未跟踪|non-?ff|无法 fast-forward/i.test(
        joined,
      ) &&
      !/linked|disposable|outside Git primary|持有|占用|非 primary|主工作区外/i.test(
        joined,
      )
    )
      state.baseBlockLine = line;
    if (baseMenu.test(joined)) state.baseMenuLine = line;
    if (baseDecision.test(joined)) state.baseDecisionLine = line;
    if (
      role === "assistant" &&
      state.mergeIntentLine &&
      writableAuth.test(joined)
    )
      add(
        state.findings,
        "MERGE_PATH_WRITABLE_CONVERGENCE_AUTH_REGRESSION",
        line,
        "merge intent was incorrectly treated as requiring a new convergence authorization",
      );
    if (
      role === "assistant" &&
      state.mergeIntentLine &&
      freshnessAuth.test(joined)
    )
      add(
        state.findings,
        "MERGE_PATH_FRESHNESS_AUTH_REGRESSION",
        line,
        "merge path requested an unnecessary PR branch update authorization",
      );
    if (kind === "function_call")
      processTerminalCommand(state, line, value, payload);
    if (kind === "function_call_output")
      processTerminalOutput(state, line, payload, joined);
    emitReadyClaim(state, line, joined);
    if (merged.test(joined) && kind !== "function_call")
      state.mergeSuccessLine ||= line;
    if (
      state.preflightSeen &&
      state.preflightEligible &&
      state.mergeCallLine &&
      !state.mergeGuarded
    )
      add(
        state.findings,
        "MERGE_HEAD_GUARD_MISSING",
        state.mergeCallLine,
        "eligible merge preflight requires an expected-head guard",
      );
    if (headBranch.test(joined))
      state.head = joined.match(headBranch)?.[1] ?? state.head;
    if (deleteExempt.test(joined)) state.deleteExemptionLine = line;
    if (isTaskComplete(value)) {
      const turnId =
        typeof payload.turn_id === "string" ||
        typeof payload.turn_id === "number"
          ? String(payload.turn_id)
          : undefined;
      const duplicate =
        turnId !== undefined && state.taskTurns.get(turnId) === task;
      if (turnId) state.taskTurns.set(turnId, task);
      if (!duplicate) emitTaskComplete(state, line, task);
    }
  }
}
