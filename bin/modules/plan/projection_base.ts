import { escapeHtml } from "./text";
import { escapeRegExp } from "./markdown";
import { parseAcceptance, type AcceptanceManifest } from "./acceptance";
import {
  PYTHON_WHITESPACE_CLASS,
  parseOrchestration,
  pythonRstrip,
  pythonStrip,
  section,
  validate,
  type BatchMap,
  type TaskMap,
  type BatchRecord,
  type TaskRecord,
} from "./orchestration";

const PYTHON_WHITESPACE = new RegExp(`[${PYTHON_WHITESPACE_CLASS}]+`, "g");

export const PROJECTION_HEADINGS = [
  "决策卡",
  "目标",
  "不包含的工作",
  "波次与依赖",
  "执行规则",
  "任务卡",
  "约束",
  "验收清单",
  "Review、运行时门禁与收口",
] as const;

export const BATCH_DISPLAY_LABELS: Record<string, string> = {
  mode: "模式",
  target: "目标",
  depends_on: "批次依赖",
  condition: "条件",
  acceptance: "验收绑定",
  observation_window: "观察窗口",
  parent_branch: "父分支",
  child_pr: "子 PR",
  topology: "拓扑",
  event_protocol: "事件协议",
  release_policy: "发布策略",
};

const FLOW_ALIASES: Record<string, Set<string>> = {
  "implement-only": new Set([
    "implement-only",
    "implement_only",
    "implementonly",
    "仅实现",
  ]),
  "retired-initiative": new Set([
    "initiative",
    "initiative-flow",
    "initiative_flow",
    "initiativeflow",
    "倡议流",
    "多ticket倡议",
  ]),
  "retired-parallel-pr": new Set([
    "parallel-pr",
    "parallel_pr",
    "parallelpr",
    "parallel-pr-flow",
    "并行pr",
    "并行-pr",
    "并行直连pr",
  ]),
  normal: new Set(["normal", "普通流程"]),
  "fast-track": new Set([
    "fast-track",
    "fast_track",
    "fastpr",
    "fast-pr",
    "fast-flow",
    "fast-pr-delivery",
    "快车道",
  ]),
  "local-merge": new Set([
    "local-merge",
    "local_merge",
    "localmerge",
    "local-merge-flow",
    "本地快车道",
    "本地合主干",
    "本地合主干流程",
    "no-pr",
    "no_pr",
    "no-pr-fast",
    "no_pr_fast",
  ]),
};

export interface Finding {
  code: string;
  message: string;
}

export function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
}
export function markdownText(value: string): string {
  return escapeHtml(value.replaceAll("\\", "\\\\"), false)
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("`", "\\`")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("#", "\\#")
    .replace(/(https?|ftp):\/\//gi, "$1&#58;//")
    .replace(/(^|[^\w])www\./gi, "$1www&#46;");
}
export function markdownCode(value: string): string {
  const runs = value.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}
export function markdownValue(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith("`") && trimmed.endsWith("`")
    ? markdownCode(trimmed.slice(1, -1))
    : markdownText(trimmed);
}
export function copyBlock(text: string, fallback: string): string[] {
  return nonEmptyLines(text).map(markdownText).length
    ? nonEmptyLines(text).map(markdownText)
    : [markdownText(fallback)];
}
function unfencedNonEmptyLines(text: string): string[] {
  let inFence = false;
  let marker = "";
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (match) {
      if (!inFence) {
        inFence = true;
        marker = match[1]!;
      } else if (
        match[1]![0] === marker[0] &&
        new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(line)
      )
        inFence = false;
      continue;
    }
    if (!inFence && line.trim()) lines.push(pythonRstrip(line));
  }
  return lines;
}
export function flowItems(text: string): Array<[string, string]> {
  return unfencedNonEmptyLines(text).map((line) => {
    const match = line.match(
      /^\s*-\s+(?:`(?<code>[^`]+)`|(?<plain>[^:：]+))\s*[:：]\s*(?<value>.+)$/,
    );
    return match?.groups
      ? [
          pythonStrip(match.groups.code ?? match.groups.plain ?? ""),
          pythonStrip(match.groups.value!),
        ]
      : ["", pythonStrip(line.replace(/^\s*-\s+/, ""))];
  });
}
export function flowValue(plan: string, key: string, fallback = ""): string {
  const value = flowItems(section(plan, "Flow Decision")).find(
    ([itemKey]) => itemKey === key,
  )?.[1];
  return value === undefined
    ? fallback
    : pythonStrip(value).replace(/^`|`$/g, "");
}
export function flowType(plan: string): string {
  const normalized = pythonStrip(flowValue(plan, "flow_type"))
    .replace(/^`|`$/g, "")
    .replaceAll("_", "-")
    .replace(PYTHON_WHITESPACE, "-")
    .toLowerCase();
  for (const [canonical, aliases] of Object.entries(FLOW_ALIASES))
    if (
      [...aliases].some(
        (alias) =>
          alias.replaceAll("_", "-").replace(/\s+/g, "-").toLowerCase() ===
          normalized,
      )
    )
      return canonical;
  return normalized;
}
export function acceptanceOptions(plan: string) {
  const type = flowType(plan);
  return { requireScopedAcceptance: type === "multi-task-flow" };
}
export function safeMermaidId(...parts: string[]): string {
  return `n_${parts.map((part) => Buffer.from(part).toString("hex")).join("__")}`;
}
export function mermaidText(value: string): string {
  return escapeHtml(value.replaceAll("\\", "\\\\"), true)
    .replaceAll("`", "&#96;")
    .replaceAll("\n", "<br/>");
}
export function displayDependency(value: string): string {
  if (value.trim().toLowerCase() === "none") return "无显式前置依赖";
  return (
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [identity = "", milestone] = item.split("/", 2);
        const clean = identity.replace(/^task:|^batch:/, "");
        return milestone
          ? `${markdownText(clean)} / ${markdownText(milestone)}`
          : markdownText(clean);
      })
      .join(", ") || "无显式前置依赖"
  );
}
