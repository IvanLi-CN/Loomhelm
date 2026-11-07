import { isRecord, type Finding, finding, type JsonRecord } from "./replay";

export const draftBootstrap = /MODE\s*=\s*draft-bootstrap|draft-bootstrap/i;
export const visualComparisonUnchanged =
  /视觉比较\s*[:=]\s*(?:一致|无差异|unchanged|same)|与上一版视觉一致/i;
export const visualResponseRequest =
  /视觉比较\s*[:=]\s*(?:需确认|有差异|不可比较|无基线)|(?:检测到|发现|存在).{0,24}(?:视觉|UI).{0,12}(?:变化|差异)|(?:截图|图片).{0,36}(?:准确反映|是否准确).{0,24}(?:确认|吗)/i;
export const ownerVisualAcceptance =
  /(?<!不)(?:确认|同意|批准).{0,36}(?:截图|图片|视觉|证据)|(?:这些|当前|该)?\s*(?:截图|图片|视觉|证据)(?:(?!不).){0,36}(?:准确|正确|没问题|符合|(?:可以|能够)反映|可以确认)|^\s*(?:(?:可以|没问题|准确|正确|是的|对(?:的)?|好的|确认|同意)\s*[，,、]?\s*)+(?:继续)?[。！!]?\s*$/i;
export const ownerVisualRejection =
  /不(?:确认|同意|批准)|(?:截图|图片|视觉|证据).{0,36}(?:不准确|不正确|不可以|不符合|不能反映|不行|有误)/i;
export const draftCandidateChanged =
  /(?:候选|head|HEAD|渲染面|渲染输入|render(?:ed)?\s*(?:surface|input)s?).{0,24}(?:已变更|变化|更新|changed)|(?:新(?:的)?\s*(?:commit|提交)|提交).{0,20}(?:新\s*SHA|已变更|变化)/i;
export const draftConvergence =
  /\bbind-pr\b|Step\s*5C\s*Ready|\bgh\s+pr\s+(?:checks|review|merge)\b|\bgh\s+run\s+(?:list|view|rerun)\b|\bgh\s+api\b[^\n]*(?:check-runs|actions\/runs|pulls\/.+\/reviews)|(?:启动|开始|进入|继续).{0,30}(?:PR\s*收敛|convergence|正式\s*review|CI\s*tracking|合并)/i;

export interface DraftState {
  bootstrapLine: number;
  visualResponseLine: number;
  feedbackResolved: boolean;
}

export function updateDraftState(
  state: DraftState,
  role: string | undefined,
  line: number,
  text: string,
): void {
  if (role === "assistant" && draftBootstrap.test(text)) {
    state.bootstrapLine = line;
    state.visualResponseLine = 0;
    state.feedbackResolved = false;
  } else if (
    role === "assistant" &&
    state.bootstrapLine &&
    visualResponseRequest.test(text)
  ) {
    state.visualResponseLine = line;
    state.feedbackResolved = false;
  } else if (
    role === "assistant" &&
    state.bootstrapLine &&
    draftCandidateChanged.test(text)
  ) {
    state.visualResponseLine = 0;
    state.feedbackResolved = false;
  } else if (
    role === "assistant" &&
    state.bootstrapLine &&
    visualComparisonUnchanged.test(text)
  ) {
    state.visualResponseLine = 0;
    state.feedbackResolved = true;
  } else if (
    role === "user" &&
    state.visualResponseLine &&
    ownerVisualAcceptance.test(text) &&
    !ownerVisualRejection.test(text)
  ) {
    state.visualResponseLine = 0;
    state.feedbackResolved = true;
  }
}

export function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flatten).join(" ");
  if (isRecord(value))
    return Object.entries(value)
      .map(([key, item]) => `${key} ${flatten(item)}`)
      .join(" ");
  return String(value);
}

export function outputText(value: unknown): string {
  const raw = flatten(value);
  try {
    const parsed: unknown = JSON.parse(raw);
    return `${raw} ${flatten(parsed)}`;
  } catch {
    return raw;
  }
}

export function callCommand(value: JsonRecord): string {
  const payload = isRecord(value.payload) ? value.payload : {};
  let args: JsonRecord = {};
  if (typeof payload.arguments === "string") {
    try {
      const parsed: unknown = JSON.parse(payload.arguments);
      if (isRecord(parsed)) args = parsed;
    } catch {
      args = {};
    }
  }
  if (typeof args.cmd === "string") return args.cmd;
  if (Array.isArray(args.command))
    return args.command
      .filter((item): item is string => typeof item === "string")
      .join(" ");
  return "";
}

export function addOnce(
  findings: Finding[],
  code: string,
  line: number,
  message: string,
): void {
  if (!findings.some((item) => item.code === code))
    findings.push(finding(code, line, message));
}
