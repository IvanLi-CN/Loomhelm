import { isRecord, type JsonRecord } from "./replay";
import { add, type TerminalState } from "./pr_terminal_state";
import { flowFromText } from "./flow_support";

export const flowType =
  /(?:^|\s)[`"']?flow[_ -]?type[`"']?\s*[:=]\s*[`"']?(multi-task-flow|multi_task_flow|multi task flow|multi-task|多任务流程|fast-track|initiative|normal|local-merge|implement-only)(?=$|[\s`"'.,;:!?，。；：])/i;
export function canonicalFlowType(value: string): string {
  return flowFromText(`flow_type: ${value}`) ?? value.trim().toLowerCase();
}
export const flowLock =
  /(?:^|\s)[`"']?(?:lock[_ -]?status|flow[_ -]?status)[`"']?\s*[:=]\s*[`"']?(locked|pending|unlocked)\b/i;
export const prExists = /PR状态\s*[:=]\s*存在|\bopen\s+PR\b|\bPR\s+exists\b/i;
export const prMissing =
  /PR状态\s*[:=]\s*不存在|no\s+(?:open\s+)?(?:PR|pull\s+request)|(?:没有|不存在|未找到).{0,12}(?:PR|pull\s+request)/i;
export const readyClaim =
  /Step\s*5C\s*Ready|step\s*5c\s*ready|PR 已到 merge-ready|latest PR 可立即合并|可立即合并/i;
export const localProof =
  /可开 PR（local）|可开 PR\(local\)|Step\s*4\s*Ready|local[\s_-]*(?:merge[\s_-]*)?proof|本地.*(?:merge[\s_-]*)?proof/i;
export const liveGate =
  /Build Artifacts.*还在跑|review proof.*还在跑|fresh review proof.*还在跑|活 proof|远端 checks .*还在跑|pending|只剩.*还在跑|当前没有新的人工决策阻断/i;
export const waitExhausted = /等待预算耗尽/i;
export const activeProof =
  /活 proof|active review proof|正式 diff 审查|startup_success/i;
export const reviewLaunchCommand =
  /(?:^|&&\s*|;\s*|\|\|\s*)codex\b[\s\S]*\breview(?:\s|$)/i;
export const activeLaunch = /Process running with session ID (\d+)/i;
export const terminalProcess =
  /Process exited with code|Unknown process id|stdin closed/i;
export const merged =
  /✓\s*Merged pull request|Merged pull request|Pull request successfully merged|结果=已合并|PR 已合并|已在 GitHub 合并成功|["']?merged["']?\s*[:=]\s*true|["']?state["']?\s*[:=]\s*["']?merged\b/i;
export const mergeOnlyIntent =
  /merge-only intent|stop condition[^\n]{0,40}merge-only|只合并|不收尾|merge\s+only|no\s+cleanup|^\s*(?:merge|合并)\s*$/i;
export const cleanupIntent =
  /merge\+cleanup intent|stop condition.*merge\+cleanup|收工条件=.*merge\+cleanup|合并.*收尾|merge\s+and\s+cleanup/i;
export const readyIntent =
  /准备好合并 PR|准备好合并|merge-ready intent|完成合并前准备/i;
export const cleanupProof =
  /cleanup_(?:status|state)\s*[:=]\s*(?:complete|completed|done)|post-merge cleanup\s*[:=]\s*(?:complete|completed|done)|cleanup_proof\s*[:=]\s*(?!unchecked|unknown|none|pending|later|future|稍后|未检查)[^\s,;；。]+|cleanup_skill_invoked\s*[:=]\s*yes|allowed_complete\s*[:=]\s*true/i;
export const baseBlocked = /主工作区基线更新\s*[:=]\s*阻断/i;
export const baseUpdated = /主工作区基线更新\s*[:=]\s*已更新/i;
export const baseDecision = /主工作区基线更新\s*[:=]\s*待主人决策/i;
export const baseAlignmentCommand =
  /base_alignment_helper|base_alignment\.ts/i;
export const baseAlignmentStructuredOutcome =
  /(?:["'`]?state["'`]?\s*[:=]\s*["'`]?(?:aligned|auto_updatable|owner_decision|blocked|recoverable_conflict)\b|["'`]?merge_scope_status["'`]?\s*[:=]\s*["'`]?(?:已更新|待自动更新|待主人决策|阻断))/i;
export const baseMenu =
  /安全对齐[\s\S]*(?:保持阻断|稍后处理|暂不处理|待主人决策)/i;
export const safeAlign = /安全对齐/i;
export const safeAlignBackup =
  /git\s+(?:branch\s+(?:(?:-f|--force)\s+)?(?!-)\S+|switch\s+-c\s+\S+|checkout\s+-b\s+\S+)/i;
export const rebase = /\bgit\s+rebase\b/i;
export const stashPush = /\bgit\s+stash\s+push\b/i;
export const stashPushUntracked =
  /\bgit\s+stash\s+push\b[^;&|]*(?:\s-u\b|\s--include-untracked\b|\s-a\b|\s--all\b)/i;
export const stashApply = /\bgit\s+stash\s+apply\b/i;
export const stashPop = /\bgit\s+stash\s+pop\b/i;
export const noStash =
  /No local changes to save|No local changes|没有本地修改|没有要保存/i;
export const stashFailure =
  /\bCONFLICT\b|conflict|could not restore|needs merge|patch failed|unmerged|\b(?:error|fatal):|failed to|失败|冲突/i;
export const commandFailure =
  /\b(?:error|fatal|gh):|HTTP\s+[45]\d\d|failed to|permission denied|remote rejected|not found|validation failed|ruleset|失败/i;
export const deleteProof =
  /远端分支\s*[:=]\s*不存在|remote branch\s*[:=]\s*(?:deleted|absent|not found)|\[deleted\]\s+\S+/i;
export const deleteExempt =
  /远端分支\s*[:=].*(?:无权限|受保护|不适用|阻断|无法删除).*?(?:fork|PR head|权限|保护|规则|permission|forbidden|403|not owner)|remote branch\s*[:=].*(?:protected|permission denied|not applicable|blocked)|head branch .*from a fork/i;
export const headBranch =
  /(?:headRefName|head_ref|head branch|PR head(?: branch)?)\s*["'` ]*[:=]\s*["'`]?([^\s"'`.,;:!?]+)/i;
export const mergeState =
  /mergeStateStatus\??["']?\s*[:=]\s*\??["']?([A-Z_]+)|`mergeStateStatus`\s*(?:还是|为)?\s*`?([A-Z_]+)`?/i;
export const mergeability =
  /mergeable_state\??["']?\s*[:=]\s*\??["']?([a-z_]+)|`mergeable_state`\s*(?:还是|为)?\s*`?([a-z_]+)`?/i;
export const writableAuth =
  /merge-only authorization does not cover|需要显式授权进入 PR convergence|switch into PR convergence/i;
export const freshnessAuth =
  /whether you may update the PR branch via `?gh`? CLI|ask a single question whether you may update the PR branch via `?gh`? CLI|是否.*更新.*PR.*branch|是否.*更新.*PR.*分支/i;

export function payloadOf(record: JsonRecord): JsonRecord {
  return isRecord(record.payload) ? record.payload : {};
}

export function taskMessage(record: JsonRecord): string {
  const payload = payloadOf(record);
  return record.type === "event_msg" &&
    payload.type === "task_complete" &&
    typeof payload.last_agent_message === "string"
    ? payload.last_agent_message
    : "";
}

export function isTaskComplete(record: JsonRecord): boolean {
  const payload = payloadOf(record);
  return record.type === "event_msg" && payload.type === "task_complete";
}

export function mutatingMerge(command: string): boolean {
  if (/^\s*(?:rg|grep|sed|printf|echo|cat)\b/i.test(command)) return false;
  if (/\bgh\s+pr\s+merge\b/i.test(command))
    return !/--help\b|-h\b/i.test(command);
  if (/(?:^|\s)pr-merge(?:\s|$)/i.test(command))
    return !/--help\b|-h\b/i.test(command);
  if (/\bgh\s+api\b[^\n]*\/pulls\/[^\n]*\/merge/i.test(command))
    return /(?:-X|--method)(?:\s+|=)(?:POST|PUT|PATCH)\b/i.test(command);
  return false;
}

export function mergePreflight(command: string): boolean {
  return (
    /mergeable|merge_state|merge_preflight|merge-preflight|pr\s+view/i.test(
      command,
    ) && !mutatingMerge(command)
  );
}

export function guardedMerge(command: string): boolean {
  return /--match-head-commit\s+\S+|--match-head-commit=\S+|--expected-head(?:\s+|=)\S+|expected[-_]head/i.test(
    command,
  );
}

export function deleteBranch(command: string): string | undefined {
  const clean = (value: string): string =>
    value.replace(/^refs\/heads\//, "").replace(/["'`]+$/, "");
  const push = command.match(
    /git\s+push\s+[^\n;|]*?(?:--delete|-d)\s+([^\s;|]+)/i,
  );
  if (push?.[1]) return clean(push[1]);
  const colon = command.match(/git\s+push\s+[^\n;|]+\s+:([^\s;|]+)/i);
  if (colon?.[1]) return clean(colon[1]);
  const api = command.match(/git\/refs\/heads\/([^\s"'`&|]+)/i);
  if (api && /(?:-X|--method)(?:\s+|=)DELETE/i.test(command))
    return clean(api[1]!);
  return undefined;
}

export function commandParts(
  command: string,
): Array<{ operator: string; text: string }> {
  const parts: Array<{ operator: string; text: string }> = [];
  let start = 0;
  let operator = "";
  for (const match of command.matchAll(/&&|\|\||;|\n/g)) {
    const text = command.slice(start, match.index).trim();
    if (text) parts.push({ operator, text });
    operator = match[0];
    start = (match.index ?? 0) + match[0].length;
  }
  const text = command.slice(start).trim();
  if (text) parts.push({ operator, text });
  return parts;
}

export function hasValidStashApply(
  command: string,
  priorRebase: boolean,
): boolean {
  const parts = commandParts(command);
  const applies = parts.flatMap((part, index) =>
    stashApply.test(part.text) ? [index] : [],
  );
  for (const index of applies) {
    const before =
      priorRebase ||
      parts.slice(0, index).some((part) => rebase.test(part.text));
    if (!before) continue;
    const rest = parts.slice(index + 1);
    const fallback = parts[index]!.operator === "||";
    if (
      fallback &&
      !rest.some((part) => stashApply.test(part.text)) &&
      !rest.some((part) => /\bexit\s+[1-9]\b/i.test(part.text))
    )
      continue;
    const branch = rest.findIndex((part) => part.operator === "||");
    if (
      branch >= 0 &&
      !rest.slice(branch).some((part) => stashApply.test(part.text)) &&
      !rest.slice(branch).some((part) => /\bexit\s+[1-9]\b/i.test(part.text))
    )
      continue;
    return true;
  }
  return false;
}

export function updateCurrentHead(
  state: TerminalState,
  line: number,
  text: string,
): void {
  if (!/current[\s ]+head|current[\s ]+sha|当前.{0,24}sha/i.test(text)) return;
  const usable =
    /(?:current[\s ]+(?:head|sha)|当前.{0,24}sha)[^\n]{0,64}(?:live|bound|fresh|not\s+stale|已绑定|当前)/i.test(
      text,
    ) ||
    /(?:live|bound|fresh|not\s+stale|已绑定)[^\n]{0,64}(?:current[\s ]+(?:head|sha)|当前.{0,24}sha)/i.test(
      text,
    );
  const explicitlyNotStale = /not\s+stale|不旧|未过期/i.test(text);
  const stale =
    /(?:current[\s ]+(?:head|sha)|当前.{0,24}sha)[^\n]{0,64}(?:old|stale|unknown|pending|later|future|missing|旧|历史|未知|缺失|不明|过期)/i.test(
      text,
    ) ||
    /(?:old|stale|unknown|pending|later|future|missing|旧|历史|未知|缺失|不明|过期)[^\n]{0,64}(?:current[\s ]+(?:head|sha)|当前.{0,24}sha)/i.test(
      text,
    );
  state.currentHeadLine = usable && (!stale || explicitlyNotStale) ? line : 0;
}

export { add };
