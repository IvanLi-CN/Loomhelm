import { parseJsonArguments, type JsonRecord } from "./replay";
import { callCommand } from "./pr_support";
import {
  activeLaunch,
  baseAlignmentCommand,
  baseAlignmentStructuredOutcome,
  commandFailure,
  deleteBranch,
  deleteProof,
  guardedMerge,
  hasValidStashApply,
  mergePreflight,
  merged,
  noStash,
  rebase,
  safeAlignBackup,
  stashApply,
  stashFailure,
  stashPop,
  stashPush,
  stashPushUntracked,
  terminalProcess,
  mutatingMerge,
  commandParts,
  reviewLaunchCommand,
} from "./pr_terminal_support";
import type { StashPush, TerminalState } from "./pr_terminal_state";

export function processTerminalCommand(
  state: TerminalState,
  line: number,
  value: JsonRecord,
  payload: JsonRecord,
): void {
  const command = callCommand(value);
  const callId = typeof payload.call_id === "string" ? payload.call_id : "";
  const args = parseJsonArguments(payload.arguments);
  const name = typeof payload.name === "string" ? payload.name : "";
  const sessionId =
    name === "write_stdin" && typeof args.session_id === "number"
      ? args.session_id
      : undefined;
  if (callId)
    state.pending.set(callId, {
      name,
      command,
      line,
      sessionId,
    });
  if (mutatingMerge(command)) {
    state.mergeCallLine ||= line;
    if (guardedMerge(command)) state.mergeGuarded = true;
  }
  if (mergePreflight(command)) state.preflightSeen = true;
  const branch = deleteBranch(command);
  if (branch) state.deleteBranchName = branch;
  if (stashPush.test(command)) {
    const item: StashPush = {
      line,
      callId: callId || undefined,
      untracked: stashPushUntracked.test(command),
      effective: true,
    };
    state.stashes.push(item);
    if (state.safeAlignLine) {
      state.safeAlignStashLine ||= line;
      state.safeAlignUntracked ||= item.untracked;
    }
  }
  if (
    state.safeAlignLine &&
    safeAlignBackup.test(command) &&
    line <= (state.safeAlignRebaseLine || Number.MAX_SAFE_INTEGER)
  )
    state.safeAlignBackupLine ||= line;
  if (rebase.test(command)) {
    state.safeAlignRebaseLine ||= state.safeAlignLine
      ? line
      : state.safeAlignRebaseLine;
    if (state.safeAlignLine && line >= state.safeAlignLine)
      state.safeAlignRebaseLine = line;
  }
  if (state.safeAlignLine && stashPop.test(command))
    state.safeAlignStashPopLine ||= line;
}

export function processTerminalOutput(
  state: TerminalState,
  line: number,
  payload: JsonRecord,
  joined: string,
): void {
  const callId = typeof payload.call_id === "string" ? payload.call_id : "";
  const call = state.pending.get(callId);
  const output = joined;
  if (
    call &&
    baseAlignmentCommand.test(call.command) &&
    baseAlignmentStructuredOutcome.test(output)
  )
    state.baseOutcomeLine ||= line;
  if (call && mergePreflight(call.command)) {
    state.preflightSeen = true;
    state.preflightEligible = /outcome["'`]?\s*[:=]\s*["'`]?eligible\b/i.test(
      output,
    );
    if (
      state.preflightEligible &&
      !/locked[_ -]?head["'`]?\s*[:=]\s*["'`]?\s*[0-9a-f]{7,64}/i.test(output)
    )
      state.preflightEligible = false;
  }
  if (
    call &&
    mutatingMerge(call.command) &&
    merged.test(output) &&
    !commandFailure.test(output)
  )
    state.mergeSuccessLine ||= line;
  const deleteAfterOr = /\|\|[^\n]*(?:git\s+push|git\/refs\/heads)/i.test(
    call?.command ?? "",
  );
  if (
    call &&
    deleteBranch(call.command) &&
    (!commandFailure.test(output) || deleteProof.test(output)) &&
    (!deleteAfterOr || deleteProof.test(output)) &&
    (deleteProof.test(output) || !output.trim() || merged.test(output)) &&
    state.head &&
    (!state.deleteBranchName || state.deleteBranchName === state.head)
  )
    state.deletedLine ||= line;
  const push = state.stashes.find((item) => item.callId === callId);
  if (push && noStash.test(output)) {
    push.effective = false;
    const effective = state.stashes.filter((item) => item.effective);
    const current = effective.find((item) => item.line >= state.safeAlignLine);
    state.safeAlignStashLine = current?.line ?? 0;
    state.safeAlignUntracked = effective.some(
      (item) => item.untracked && item.line >= state.safeAlignLine,
    );
  }
  const fallbackRecovered =
    /conflicts in index|try without --index/i.test(output) &&
    commandParts(call?.command ?? "").filter((part) =>
      stashApply.test(part.text),
    ).length > 1;
  if (
    call &&
    state.safeAlignLine &&
    stashApply.test(call.command) &&
    (!stashFailure.test(output) || fallbackRecovered) &&
    hasValidStashApply(
      call.command,
      Boolean(
        state.safeAlignRebaseLine && state.safeAlignRebaseLine < call.line,
      ),
    )
  )
    state.safeAlignStashApplyLine ||= call.line;
  const launched =
    call?.name === "exec_command" && reviewLaunchCommand.test(call.command)
      ? output.match(activeLaunch)
      : null;
  if (launched) {
    const session = Number(launched[1]);
    state.activeSessions.add(session);
    state.activeReviewSessions.add(session);
    if (state.activeProofIntentLine) {
      state.activeProofSessions.add(session);
      state.activeProofLine = state.activeProofIntentLine;
    }
  }
  if (
    call?.name === "write_stdin" &&
    call.sessionId &&
    terminalProcess.test(output)
  ) {
    state.activeSessions.delete(call.sessionId);
    state.activeReviewSessions.delete(call.sessionId);
    state.activeProofSessions.delete(call.sessionId);
    if (!state.activeProofSessions.size) {
      state.activeProofLine = 0;
      state.activeProofIntentLine = 0;
    }
  }
  if (merged.test(output)) state.mergeSuccessLine ||= line;
}
