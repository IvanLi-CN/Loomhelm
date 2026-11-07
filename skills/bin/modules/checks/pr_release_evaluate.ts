import {
  failureDisposition,
  failureSurface,
  noExpectedEvidence,
  rerunDisposition,
  timeoutIncomplete,
  timeoutRecovery,
} from "./pr_release_rules";
import { add, taskMessage, type ReleaseState } from "./pr_release_state";
import {
  identifiersMatch,
  reportFieldMissing,
  releaseIntent,
  releaseStatus,
  shaMatches,
} from "./pr_release_support";
import { evaluatePublished } from "./pr_release_publish";

export function evaluateRelease(
  state: ReleaseState,
  line: number,
  message: string,
): void {
  const finalStatus = message.match(releaseStatus)?.[1];
  if (finalStatus) {
    state.status = finalStatus;
    state.statusLine = line;
  }
  if (releaseIntent.test(message)) state.releaseIntentLine ||= line;
  const snapshotClosedOut =
    /Release Snapshot|CI\s*(?:与|and)\s*Release Snapshot|任务完成/i.test(
      message,
    ) && /(?:通过|完成|passed|complete|done)/i.test(message);
  if (state.mergeLine && !finalStatus && snapshotClosedOut)
    add(
      state.findings,
      "POST_MERGE_RELEASE_CLOSED_OUT_EARLY",
      line,
      "release snapshot was closed out without a terminal release status",
    );
  else if (state.mergeLine && !finalStatus)
    add(
      state.findings,
      "RELEASE_STATUS_MISSING_AFTER_MERGE",
      line,
      `merge_success_line=${state.mergeLine}`,
    );
  if (
    state.expected !== undefined &&
    state.expected !== "unknown" &&
    state.mergeLine === 0 &&
    state.releaseExpectationLine &&
    (releaseStatus.test(message) || /Step\s*5C|merge-ready/i.test(message))
  )
    add(
      state.findings,
      "RELEASE_EXPECTED_PREMERGE",
      line,
      `release_expectation_line=${state.releaseExpectationLine}`,
    );
  if (
    finalStatus === "不适用" &&
    (state.expected !== undefined ||
      (/(?:merged|合并)/i.test(message) &&
        !/(?:not\s+merged|未合并|未成功合并)/i.test(message)))
  )
    add(
      state.findings,
      "RELEASE_EXPECTATION_STATUS_MISMATCH",
      line,
      `release_expected=${state.expected ?? "unknown"}`,
    );
  if (finalStatus === "未触发" && state.expected !== false)
    add(
      state.findings,
      "RELEASE_EXPECTATION_STATUS_MISMATCH",
      line,
      "not-triggered status requires release_expected=false",
    );
  if (state.expected === false && finalStatus && finalStatus !== "未触发")
    add(
      state.findings,
      "RELEASE_EXPECTATION_STATUS_MISMATCH",
      line,
      `release_expected=false final_status=${finalStatus}`,
    );
  if (
    state.expected === "unknown" &&
    finalStatus &&
    !["运行中", "未终态", "未检查"].includes(finalStatus)
  )
    add(
      state.findings,
      "RELEASE_EXPECTATION_STATUS_MISMATCH",
      line,
      "unknown release expectation must remain unresolved",
    );
  if (finalStatus === "已发布" && state.expected !== true)
    add(
      state.findings,
      "RELEASE_EXPECTATION_STATUS_MISMATCH",
      line,
      "published status requires release_expected=true",
    );
  if (
    ["运行中", "失败", "未终态", "未检查"].includes(finalStatus ?? "") &&
    state.expected === undefined
  )
    add(
      state.findings,
      "RELEASE_EXPECTATION_STATUS_MISMATCH",
      line,
      `release status ${finalStatus} lacks trusted expectation`,
    );
  if (
    finalStatus === "失败" &&
    (!state.failureEvidence ||
      (state.lastRerunLine &&
        state.failureEvidenceLine <= state.lastRerunLine)) &&
    (!state.releaseRerunAttempted || state.userAuthorizedRerun)
  )
    add(
      state.findings,
      "RELEASE_FAILURE_EVIDENCE_MISSING",
      line,
      "failed status has no bound failed run or artifact fact",
    );
  if (
    finalStatus === "失败" &&
    (!state.releaseRerunAttempted || state.userAuthorizedRerun) &&
    (!failureSurface.test(message) || !failureDisposition.test(message))
  )
    add(
      state.findings,
      "RELEASE_FAILURE_REPORT_INCOMPLETE",
      line,
      "failed status requires failure surface and owner-action-required disposition",
    );
  if (finalStatus === "未终态" && state.expected !== undefined) {
    const missing = reportFieldMissing(message);
    if (missing.length)
      add(
        state.findings,
        "RELEASE_REPORT_FIELDS_MISSING",
        line,
        `missing_fields=${missing.join(",")}`,
      );
  }
  if (
    finalStatus === "未触发" &&
    state.expected === false &&
    state.rerunCount === 0 &&
    !noExpectedEvidence.test(message.replace(/发布状态\s*[:=]\s*未触发/gi, ""))
  )
    add(
      state.findings,
      "RELEASE_NOT_EXPECTED_EVIDENCE_MISSING",
      line,
      "not-triggered status lacks repository-contract or live skip evidence",
    );
  if (
    ["运行中", "未终态", "未检查"].includes(finalStatus ?? "") &&
    !/等待预算耗尽/.test(message) &&
    !(
      /未终态/.test(finalStatus ?? "") &&
      /tracker|watcher|追踪.*不可用|unavailable/i.test(message)
    )
  )
    add(
      state.findings,
      "POST_MERGE_RELEASE_CLOSED_OUT_EARLY",
      line,
      `release_status=${finalStatus}`,
    );
  if (
    /等待预算耗尽/.test(message) &&
    state.expected === true &&
    finalStatus !== "未终态"
  )
    add(
      state.findings,
      "RELEASE_TIMEOUT_STATUS_MISMATCH",
      line,
      "wait exhaustion must close as release status 未终态",
    );
  if (
    finalStatus === "未终态" &&
    /等待预算耗尽/.test(message) &&
    (!timeoutIncomplete.test(message) || !timeoutRecovery.test(message))
  )
    add(
      state.findings,
      "RELEASE_RECOVERY_ANCHOR_MISSING",
      line,
      "release timeout lacks incomplete post-merge and recovery anchor",
    );
  if (
    state.rerunViolation ||
    (rerunDisposition.test(message) && state.rerunCount !== 1)
  )
    add(
      state.findings,
      "RELEASE_RERUN_SAFETY_VIOLATION",
      line,
      `rerun_count=${state.rerunCount}`,
    );
  if (state.identityConflictLine)
    add(
      state.findings,
      "RELEASE_EPOCH_IDENTITY_CONFLICT",
      line,
      `identity_conflict_line=${state.identityConflictLine}`,
    );
  if (
    state.target.sha &&
    state.bound &&
    !shaMatches(state.target.sha, state.bound)
  )
    add(
      state.findings,
      "RELEASE_SHA_BINDING_MISMATCH",
      line,
      `target_sha=${state.target.sha} reported_sha=${state.bound}`,
    );
  if (
    state.candidate &&
    state.reported.tag &&
    !identifiersMatch(state.candidate, state.reported.tag)
  )
    add(
      state.findings,
      "RELEASE_TAG_BINDING_MISMATCH",
      line,
      `candidate_tag=${state.candidate} reported_tag=${state.reported.tag}`,
    );
  if (finalStatus === "已发布") evaluatePublished(state, line, message);
}
