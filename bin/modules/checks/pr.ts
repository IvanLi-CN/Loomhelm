import {
  finding,
  eventTexts,
  isRecord,
  readJsonLines,
  result,
  type Finding,
  type ReplayResult,
} from "./replay";
import {
  addOnce,
  callCommand,
  draftConvergence,
  type DraftState,
  flatten,
  outputText,
  updateDraftState,
} from "./pr_support";
import { analyzePrRelease } from "./pr_release";
import { analyzePrTerminal } from "./pr_terminal";
import { analyzePostMergeHandoff } from "./pr_handoff";

const approvalRequired = /approval|批准|审批/i;
const approvalNotRequired =
  /approval not required|不需要 approval|无需批准|admin permission/i;
const conflict =
  /mergeable_state["']?\s*[:=]\s*["']?dirty|\bdirty\b|冲突|conflict|不可合并/i;
const mergeCommand =
  /(?:^|\s)(?:\S+\/)?gh\s+(?:--repo\s+\S+\s+)?pr\s+merge|(?:\S+\/)?gh\s+api\s+[^\n]*\/pulls\/[^\n]*\/merge|pr-merge/i;
const deleteCommand =
  /git\s+push\s+\S+\s+--delete\s+\S+|gh\s+api\s+[^\n]*git\/refs\/heads\/[^\n]*(?:-X|--method)\s*=?\s*DELETE|\[deleted\]/i;
const merged =
  /PR 已 merged|PR 已合并|结果=已合并|Merged pull request|已在 GitHub 合并成功|["']?state["']?\s*[:=]\s*["']?merged\b/i;
const ready = /Step\s*5C\s*Ready|step\s*5c\s*ready|merge-ready/i;
const step5c = /Step\s*5C\s*Ready|step\s*5c\s*ready/i;
const mergeReady = /merge-ready/i;
const noOpenPr =
  /PR状态\s*[:=]\s*不存在|no\s+(?:open\s+)?(?:PR|pull\s+request)|(?:没有|不存在|未找到).{0,12}(?:PR|pull\s+request|可开 PR)/i;
const fastTrack = /flow[_ -]*type\s*[:=]\s*`?fast[-_ ]?track|fast-track/i;
const cleanupIntent =
  /merge\s+and\s+cleanup|合并.*收尾|merge\+cleanup|本地收尾|cleanup/i;
const cleanupProof = /cleanup_proof\s*=\s*([^\s`，。；;,]+)/i;
const baseBlocker =
  /主工作区基线更新\s*[:=]\s*阻断|base[^\n]{0,30}(?:blocked|behind|diverged)|基线.{0,12}(?:阻断|落后|无法 fast-forward)/i;
const baseMenu = /安全对齐[\s\S]*(?:保持阻断|稍后处理|暂不处理|待主人决策)/i;
const safeAlign = /安全对齐/i;
const genericMergeIntent = /\bmerge\b|合并/i;
const currentHead =
  /current\s+head|当前(?:live\s*)?head|live_head|headRefName/i;
const routeCard =
  /pre_merge_release_route|release_route|current_repository_facts|current_pr_facts/i;

function isMutatingMergeCommand(command: string): boolean {
  if (/\bgh\s+pr\s+merge\b/i.test(command) || /\bpr-merge\b/i.test(command))
    return !/--help\b|-h\b|--dry-run\b/i.test(command);
  if (/\bgh\s+api\b[^\n]*\/pulls\/[^\n]*\/merge/i.test(command))
    return !/\s(?:-X|--method)(?:\s+|=)GET\b/i.test(command);
  return false;
}

export function analyzePrReplay(path: string): ReplayResult {
  const findings: Finding[] = [];
  let mergeability = "";
  let approvalEvidence = 0;
  let approvalWait = 0;
  let mergePromise = 0;
  let continueAfterPromise = 0;
  let prExists: boolean | undefined;
  let fastTrackLine = 0;
  let readyLine = 0;
  let step5cLine = 0;
  let mergeReadyLine = 0;
  let mergeIntentLine = 0;
  let mergeCallLine = 0;
  let mergeCallGuarded = false;
  let mergePreflightSeen = false;
  let mergeDeleteFalse = false;
  let mergeSuccessLine = 0;
  let deleteLine = 0;
  let deletedBranch = "";
  let headBranch = "";
  let cleanupRequested = false;
  let cleanupProofLine = 0;
  let cleanupProofPositive = false;
  let baseBlockLine = 0;
  let baseMenuLine = 0;
  let safeAlignLine = 0;
  let hadRebase = false;
  let hadBackup = false;
  let hadStash = false;
  let hadStashUntracked = false;
  let hadStashApply = false;
  let hadStashPop = false;
  let deletedBranchAttempt = false;
  let routeCardSeen = false;
  let candidateChange = false;
  const draft: DraftState = {
    bootstrapLine: 0,
    visualResponseLine: 0,
    feedbackResolved: false,
  };
  for (const { line, value } of readJsonLines(path)) {
    const { kind, role, texts } = eventTexts(value);
    const joined = texts.join("\n");
    const payload = isRecord(value.payload) ? value.payload : {};
    if (!joined && kind !== "function_call") continue;
    if (routeCard.test(joined)) routeCardSeen = true;
    if (role === "assistant" || role === "user") {
      updateDraftState(draft, role, line, joined);
      if (approvalNotRequired.test(joined)) approvalEvidence ||= line;
      if (
        approvalRequired.test(joined) &&
        !approvalNotRequired.test(joined) &&
        /wait|等待|门禁|before merge|合并前/i.test(joined)
      )
        approvalWait ||= line;
      if (
        /如果你要|下一步可以|继续轮询|directly continue|继续处理合并/i.test(
          joined,
        ) &&
        /merge|合并/i.test(joined)
      )
        mergePromise ||= line;
      if (
        role === "user" &&
        /^(?:继续|continue)\s*$/i.test(joined.trim()) &&
        mergePromise
      )
        continueAfterPromise ||= line;
      if (/PR状态\s*[:=]\s*存在|open PR|PR exists/i.test(joined))
        prExists = true;
      if (noOpenPr.test(joined) && !/远端分支|remote branch/i.test(joined))
        prExists = false;
      if (fastTrack.test(joined)) fastTrackLine ||= line;
      if (ready.test(joined)) readyLine ||= line;
      if (step5c.test(joined)) step5cLine ||= line;
      if (mergeReady.test(joined)) mergeReadyLine ||= line;
      if (
        role === "user" &&
        /merge-only intent|只合并|不收尾|merge\s+only|no\s+cleanup|^\s*(?:merge|合并)\s*$/i.test(
          joined.trim(),
        )
      )
        mergeIntentLine ||= line;
      if (
        currentHead.test(joined) &&
        /headRefName\s*=\s*([\w./-]+)/i.test(joined)
      )
        headBranch =
          joined.match(/headRefName\s*=\s*([\w./-]+)/i)?.[1] ?? headBranch;
      if (
        (role === "user" && cleanupIntent.test(joined)) ||
        (role === "assistant" &&
          /接下来会|下一步会|继续调用|cleanup_proof/i.test(joined) &&
          /cleanup|收尾/i.test(joined))
      )
        cleanupRequested = true;
      const proof = joined.match(cleanupProof)?.[1]?.toLowerCase();
      if (proof) {
        cleanupProofLine ||= line;
        cleanupProofPositive ||= ![
          "unchecked",
          "unknown",
          "none",
          "pending",
          "later",
          "future",
          "blocked",
          "未检查",
          "稍后生成",
        ].includes(proof);
      }
      if (
        baseBlocker.test(joined) &&
        !/primary worktree on another branch|non-checkout base ref update failed/i.test(
          joined,
        )
      )
        baseBlockLine ||= line;
      if (baseMenu.test(joined)) baseMenuLine ||= line;
      if (role === "user" && safeAlign.test(joined)) safeAlignLine ||= line;
      if (
        /候选|candidate|rendered/i.test(joined) &&
        /changed|变化|变更|更新/i.test(joined)
      )
        candidateChange = true;
    }
    if (kind === "function_call") {
      const command = callCommand(value);
      if (
        isMutatingMergeCommand(command) &&
        !/rg\s|grep\s|sed\s|printf\s/i.test(command)
      ) {
        mergeCallLine ||= line;
        mergeCallGuarded ||=
          /--(?:match-head-commit|expected-head|expected_head_sha)|expected[-_]head/i.test(
            command,
          );
        mergeDeleteFalse ||= /--delete-branch=false/i.test(command);
      } else if (
        /gh\s+pr\s+merge|pr-merge/i.test(command) &&
        /rg\s|grep\s|sed\s|printf\s/i.test(command)
      )
        mergeIntentLine ||= line;
      if (deleteCommand.test(command)) {
        deleteLine ||= line;
        deletedBranchAttempt = true;
        deletedBranch ||= command.match(/--delete\s+([^\s;&|]+)/i)?.[1] ?? "";
      }
      if (/git\s+rebase\b/i.test(command)) {
        hadRebase = true;
      }
      if (
        /git\s+branch\s+(?:-f\s+)?(?:backup|[\w./-]*backup)/i.test(command) ||
        /backup[-_ ]branch/i.test(command)
      )
        hadBackup = true;
      if (/git\s+stash\s+push/i.test(command)) {
        hadStash = true;
        hadStashUntracked ||= /(?:-u|--include-untracked)/.test(command);
      }
      if (/git\s+stash\s+(?:apply|pop)/i.test(command)) {
        hadStashApply ||= /stash\s+apply/i.test(command);
        hadStashPop ||= /stash\s+pop/i.test(command);
      }
    }
    if (kind === "function_call_output") {
      const out = outputText(isRecord(payload) ? payload.output : undefined);
      if (approvalNotRequired.test(out)) approvalEvidence ||= line;
      if (/merge_guard|locked_head|merge_preflight/i.test(out))
        mergePreflightSeen = true;
      if (/mergeable_state["']?\s*[:=]\s*["']?([a-z_-]+)/i.test(out))
        mergeability =
          out
            .match(/mergeable_state["']?\s*[:=]\s*["']?([a-z_-]+)/i)?.[1]
            ?.toLowerCase() ?? mergeability;
      if (/\bdirty\b|\bconflicting\b/i.test(out)) mergeability = "dirty";
      if (merged.test(out) || /["']merged["']\s*:\s*true/i.test(out))
        mergeSuccessLine ||= line;
      if (deleteCommand.test(out)) {
        deleteLine ||= line;
        deletedBranchAttempt = true;
      }
    }
    if (merged.test(joined)) mergeSuccessLine ||= line;
    if (
      (role === "assistant" || kind === "function_call") &&
      draft.bootstrapLine &&
      !draft.feedbackResolved &&
      line >= draft.bootstrapLine &&
      draftConvergence.test(joined)
    )
      addOnce(
        findings,
        draft.visualResponseLine
          ? "DRAFT_PR_CONVERGENCE_BEFORE_VISUAL_RESPONSE"
          : "DRAFT_PR_CONVERGENCE_BEFORE_VISUAL_FEEDBACK",
        line,
        draft.visualResponseLine
          ? `visual_response_line=${draft.visualResponseLine}`
          : `draft_bootstrap_line=${draft.bootstrapLine}`,
      );
  }
  if (approvalWait && mergeability === "dirty")
    addOnce(
      findings,
      "CONFLICT_MISDIAGNOSED_AS_APPROVAL",
      approvalWait,
      "dirty mergeability was described as an approval blocker",
    );
  if (
    approvalEvidence &&
    approvalWait &&
    !mergePromise &&
    mergeability !== "dirty"
  )
    addOnce(
      findings,
      "APPROVAL_EVIDENCE_IGNORED",
      approvalWait,
      `approval evidence line=${approvalEvidence} was ignored`,
    );
  if (continueAfterPromise && approvalWait && approvalEvidence)
    addOnce(
      findings,
      "PROMISED_MERGE_BRANCH_NOT_RESUMED",
      approvalWait,
      `merge promise line=${mergePromise} continuation line=${continueAfterPromise}`,
    );
  for (const extra of [
    ...analyzePrTerminal(path),
    ...analyzePrRelease(path),
    ...analyzePostMergeHandoff(path).findings,
  ])
    addOnce(findings, extra.code, extra.line, extra.message);
  return result(findings);
}
