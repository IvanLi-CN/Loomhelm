/** Read-only presentation product, never a dispatch authorization or persisted state. */
export const GROUP_STATUS_STATES = ["planned", "active", "merged", "closed", "blocked"] as const;
export const TASK_STATUS_STATES = [
  "planned",
  "ready",
  "starting",
  "running",
  "agent_idle",
  "waiting",
  "blocked",
  "integrated",
  "completed",
  "closed",
] as const;
const readinessStates = ["ready", "blocked", "unknown"];

export type DetailStatusInput = {
  kind: "task" | "group";
  state: string;
  visualState?: string;
  runtime?: string;
  dispatch?: string;
};

/** Only constraints proven by the current view producer belong here. */
export function detailStatusIssue(input: DetailStatusInput): string | null {
  const states: readonly string[] =
    input.kind === "group" ? GROUP_STATUS_STATES : TASK_STATUS_STATES;
  if (!states.includes(input.state)) return `未识别的状态：${input.state}`;
  if (!input.runtime || !input.dispatch) return "状态数据不完整";
  if (!readinessStates.includes(input.runtime) || !readinessStates.includes(input.dispatch))
    return "未识别的就绪或调度状态";
  if (input.kind === "group") {
    if (input.dispatch === "unknown") return "交付单元调度状态尚未确认";
    if (input.state !== "active" && input.dispatch === "ready")
      return "状态组合不一致：非 active 交付单元不可调度";
    if (["planned", "blocked", "closed"].includes(input.state) && input.runtime === "ready")
      return "状态组合不一致：当前交付单元状态不允许运行就绪";
    // Coordinator observation can overlay a raw planned/blocked/merged state.
    if (
      input.visualState &&
      ![
        input.state,
        "running",
        "waiting",
        "blocked",
        ...(input.state === "active" ? ["idle", "unknown"] : []),
      ].includes(input.visualState)
    )
      return "未识别的执行观察状态";
    if (input.state === "closed" && input.visualState && input.visualState !== "closed")
      return "状态组合不一致：已收口单元不能覆盖为执行观察状态";
  } else if (input.visualState && input.visualState !== input.state) {
    return "状态组合不一致：任务状态与展示状态不匹配";
  }
  return null;
}

export function deriveDetailStatus(input: DetailStatusInput) {
  const issue = detailStatusIssue(input);
  // Keep every coordinate, including observation, even when glyphs share a category.
  const key = JSON.stringify([
    input.kind,
    input.state,
    input.visualState ?? input.state,
    input.runtime ?? null,
    input.dispatch ?? null,
  ]);
  const result = (presentation: string, icon: string, tone: string, label: string) => ({
    key,
    presentation,
    icon,
    tone,
    label,
    issue,
  });
  if (
    issue ||
    input.runtime === "unknown" ||
    input.dispatch === "unknown" ||
    input.visualState === "unknown"
  )
    return result("unknown", "circle-help", "muted", "状态待确认");
  const state = input.visualState ?? input.state;
  if (["integrated", "completed", "closed", "merged"].includes(state))
    return result("finished", "circle-check", "positive", "已结束");
  if (state === "blocked" || input.runtime === "blocked")
    return result("blocked", "circle-alert", "negative", "运行阻塞");
  if (["running", "starting", "active"].includes(state))
    return result("running", "loader-circle", "accent", "执行中");
  if (["waiting", "agent_idle", "idle"].includes(state))
    return result("waiting", "hourglass", "warning", "等待中");
  if (input.dispatch === "blocked")
    return result("gated", "circle-dashed", "muted", "调度门禁未通过");
  return result("ready", "circle-dot", "positive", "就绪");
}
