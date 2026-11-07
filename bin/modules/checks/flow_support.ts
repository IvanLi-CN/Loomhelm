import {
  finding,
  isRecord,
  parseJsonArguments,
  readJsonLines,
  type Finding,
} from "./replay";
import { flowReceiptCommandTail, repairWaveCommand } from "./flow_route";

const aliases: Record<string, string[]> = {
  "multi-task-flow": [
    "multi-task-flow",
    "multi_task_flow",
    "multi task flow",
    "multi-task",
    "多任务流程",
  ],
  "implement-only": [
    "implement-only",
    "implement_only",
    "implementonly",
    "implement only",
    "仅实现",
  ],
  normal: ["normal", "普通流程"],
  "fast-track": [
    "fast-track",
    "fast_track",
    "fastpr",
    "fast-pr-delivery",
    "fast flow",
    "fast-flow",
    "fast pr",
    "fast-pr",
    "快车道",
  ],
  "local-merge": [
    "local-merge",
    "local_merge",
    "localmerge",
    "local merge",
    "local-merge-flow",
    "本地快车道",
    "本地合主干",
    "本地合主干流程",
    "no-pr",
    "no_pr",
    "no-pr-fast",
    "no_pr_fast",
    "no-pr fast",
    "no_pr fast",
  ],
  "retired-initiative": [
    "initiative",
    "initiative-flow",
    "initiative_flow",
    "initiativeflow",
    "倡议流",
    "多ticket倡议",
  ],
  "retired-parallel-pr": [
    "parallel-pr",
    "parallel_pr",
    "parallelpr",
    "parallel-pr-flow",
    "并行pr",
    "并行-pr",
    "并行直连pr",
  ],
};

function canonicalFlow(text: string): string | undefined {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  let best: { length: number; flow: string } | undefined;
  for (const [flow, values] of Object.entries(aliases))
    for (const value of values) {
      const needle = value.toLowerCase().replace(/\s+/g, " ");
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const boundary = new RegExp(`(^|[^a-z0-9_-])${escaped}([^a-z0-9_-]|$)`);
      if (boundary.test(normalized) && (!best || needle.length > best.length))
        best = { length: needle.length, flow };
    }
  return best?.flow;
}

export function flowFromText(text: string): string | undefined {
  const match = text.match(
    /(?:flow[_ -]*type|流程类型)\s*[:=：]\s*`?([^\n`]+)`?/i,
  );
  return match ? canonicalFlow(match[1]!) : canonicalFlow(text);
}

export function unfencedText(text: string): string {
  const lines: string[] = [];
  let fenceCharacter: string | undefined;
  let fenceLength = 0;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fenceCharacter) {
        fenceCharacter = marker[1]![0];
        fenceLength = marker[1]!.length;
      } else if (
        marker[1]![0] === fenceCharacter &&
        marker[1]!.length >= fenceLength &&
        new RegExp(`^\\s{0,3}${fenceCharacter}{${fenceLength},}\\s*$`).test(
          line,
        )
      ) {
        fenceCharacter = undefined;
        fenceLength = 0;
      }
      continue;
    }
    if (!fenceCharacter) lines.push(line);
  }
  return lines.join("\n");
}

const flowField =
  /(^|\n)[ \t]*(?:-[ \t]*)?(?:`?flow[\s_-]*type`?|流程类型)[ \t]*[:=：][ \t]*`?([^\n`]+)`?/i;
const explicitSwitch = /改为|切到|切换到|锁定|走|按|用|采用|选择|设为/;
const genericContinuePattern =
  /\[\$flow-continue\]|继续|推进流程|接着做|你直接做吧|你直接收尾吧|合并并收尾|收尾|合并/i;
const genericContinue =
  /\[\$flow-continue\]|继续|推进流程|接着做|你直接做吧|你直接收尾吧|合并并收尾|收尾|合并/g;
const negationCue =
  /\b(?:do\s+not|don't|not\s+yet|wait)\b|不要|不得|禁止|暂停|等待主人确认|先等待/i;

export function shouldIgnoreUserBlob(text: string): boolean {
  const stripped = text.trimStart();
  return (
    stripped.startsWith("<skill>") ||
    stripped.startsWith("# AGENTS.md instructions")
  );
}

export function extractFlowLock(
  text: string,
  role: string | undefined,
): string | undefined {
  const visible = unfencedText(text);
  const field = visible.match(flowField);
  if (field) return canonicalFlow(field[2]!);
  if (
    role === "assistant" &&
    visible.includes("<proposed_plan>") &&
    visible.includes("Flow Decision")
  )
    return canonicalFlow(visible);
  if (
    role === "user" &&
    !visible.trimStart().startsWith("<skill>") &&
    visible.length <= 300 &&
    explicitSwitch.test(visible)
  )
    return canonicalFlow(visible);
  return undefined;
}

const explicitTopLevelFlowSwitch =
  /top[- ]level|parent (?:flow|route)|顶层|父级|主流程|显式.*流程/i;

export function isNestedTaskFlow(
  parentFlow: string | undefined,
  nextFlow: string,
  role: string | undefined,
  text: string,
): boolean {
  if (
    parentFlow !== "multi-task-flow" ||
    nextFlow === "multi-task-flow" ||
    role === "user"
  )
    return false;
  return !explicitTopLevelFlowSwitch.test(unfencedText(text));
}

export function isUserFlowLockCandidate(text: string): boolean {
  if (shouldIgnoreUserBlob(text)) return false;
  const visible = unfencedText(text);
  return (
    flowField.test(visible) ||
    (visible.length <= 300 && explicitSwitch.test(visible))
  );
}

export function isContinue(text: string): boolean {
  const visible = unfencedText(text);
  return (
    genericContinuePattern.test(visible) &&
    !isNegatedContinue(visible) &&
    extractFlowLock(visible, "user") === undefined
  );
}

export function isNegatedContinue(text: string): boolean {
  const visible = unfencedText(text);
  genericContinue.lastIndex = 0;
  for (const match of visible.matchAll(genericContinue)) {
    const start = Math.max(0, (match.index ?? 0) - 64);
    const end = Math.min(
      visible.length,
      (match.index ?? 0) + match[0].length + 64,
    );
    if (negationCue.test(visible.slice(start, end))) return true;
  }
  genericContinue.lastIndex = 0;
  return false;
}

export function isRouteAttempt(
  kind: string | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (kind !== "function_call") return false;
  const name = typeof payload.name === "string" ? payload.name : "";
  const rawArguments = payload.arguments;
  if (typeof rawArguments !== "string") return false;
  const args = parseJsonArguments(rawArguments);
  if (name === "load_skill") {
    const paths = [
      "skills/pr-create/SKILL.md",
      "skills/project-engineering-workflow/references/pr-publication-procedure.md",
    ];
    return (
      paths.includes(String(args.path)) ||
      paths.some((path) => rawArguments.includes(path))
    );
  }
  if (name !== "exec" && name !== "exec_command") return false;
  const command = typeof args.cmd === "string" ? args.cmd : "";
  if (flowReceiptCommandTail(command)) return true;
  return (
    typeof rawArguments === "string" &&
    /flow_receipt\.(?:ts|py)/.test(rawArguments) &&
    /review-wave\s+open/.test(rawArguments)
  );
}

export function routeIsValid(payload: Record<string, unknown>): boolean {
  const name = typeof payload.name === "string" ? payload.name : "";
  if (typeof payload.arguments !== "string") return false;
  const args = parseJsonArguments(payload.arguments);
  if (name === "load_skill")
    return (
      Object.keys(args).length === 1 &&
      [
        "skills/pr-create/SKILL.md",
        "skills/project-engineering-workflow/references/pr-publication-procedure.md",
      ].includes(String(args.path))
    );
  if (name !== "exec" && name !== "exec_command") return false;
  const command = typeof args.cmd === "string" ? args.cmd : "";
  return repairWaveCommand(flowReceiptCommandTail(command));
}
