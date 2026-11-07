import type { AgentOutput } from "./agent-output";
import type { View } from "./model";
import { formatDuration, fullLocalTime } from "./time";
import type { PRSnapshot } from "../scripts/pr-details";
import { attachTooltip } from "./tooltip";
let serial = 0;
let active: { close: (restore?: boolean) => void; refresh: () => void } | null = null;
export function refreshResourcePopover(): void { active?.refresh(); }
export function closeResourcePopover(): void { active?.close(); }
const node = (tag: string, value = "", className = "") => { const n = document.createElement(tag); n.textContent = value; n.className = className; return n; };
function icon(name: "copy" | "refresh" | "external"): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
  const paths: Record<string, string[]> = { copy: ["M9 9h10v10H9z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"], refresh: ["M20 11a8 8 0 1 0 2 5.3", "M20 4v7h-7"], external: ["M14 3h7v7", "M21 3 11 13", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"] };
  for (const d of paths[name]!) { const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", d); path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "2"); path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round"); svg.append(path); } return svg;
}
export type ResourceSource = { kind: "task" | "group"; id: string; thread: string | null; output: () => AgentOutput | undefined; start: string | null; end: string | null; view: View };
type Tone = "neutral" | "live" | "positive" | "warning" | "negative";
function badge(value: string, tone: Tone): HTMLElement {
  const element = node("span", value, "resource-badge"); element.dataset.tone = tone; return element;
}
function checkTone(value: string): Tone {
  return value === "SUCCESS" ? "positive" : ["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED", "EXPECTED"].includes(value) ? "live" : ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(value) ? "negative" : "neutral";
}
function checkLabel(value: string): string {
  const labels: Record<string, string> = { SUCCESS: "通过", FAILURE: "失败", ERROR: "错误", CANCELLED: "已取消", TIMED_OUT: "超时", ACTION_REQUIRED: "需操作", IN_PROGRESS: "运行中", QUEUED: "排队中", PENDING: "等待中", SKIPPED: "已跳过", NEUTRAL: "中立", UNKNOWN: "未知" };
  return labels[value] ? `${labels[value]} · ${value}` : value;
}
function copyRow(label: string, value: string | null, href: string | null = null): HTMLElement {
  const row = node("div", "", "resource-copy-row");
  row.dataset.field = label === "标题" ? "title" : "identifier";
  const content = node("div", "", "resource-field");
  content.append(node("span", label, "resource-label"));
  const valueNode = href && value ? document.createElement("a") : node("span", value || "不可用", "resource-value");
  valueNode.className = "resource-value"; valueNode.textContent = value || "不可用";
  if (href && valueNode instanceof HTMLAnchorElement) { valueNode.href = href; valueNode.target = "_blank"; valueNode.rel = "noopener noreferrer"; }
  content.append(valueNode);
  row.append(content);
  if (value) {
    const action = `复制${label}`;
    const button = document.createElement("button"); button.type = "button"; button.className = "resource-icon-button"; button.setAttribute("aria-label", action); button.dataset.action = action;
    button.append(icon("copy"));
    const hint = attachTooltip(button, node("span", action), action); row.append(button, hint);
    button.addEventListener("click", async () => { try { await navigator.clipboard.writeText(value); button.dataset.feedback = "已复制"; } catch { button.dataset.feedback = "复制失败"; } });
  }
  return row;
}
export function timingText(source: ResourceSource, now = Date.now()): string {
  const planned = source.kind === "task" ? source.view.planned_intervals.find(p => source.view.nodes.some(n => n.id === p.node_id && n.kind === "task" && n.ref_id === source.id)) : null;
  const groupBound = (kind: string) => source.view.planned_intervals.find(p => source.view.nodes.some(n => n.id === p.node_id && n.kind === kind && n.group_id === source.id));
  const start = planned?.start ?? (source.kind === "group" ? groupBound("group_start")?.start : null);
  const end = planned?.end ?? (source.kind === "group" ? groupBound("group_end")?.end : null);
  const validDate = (v: string | null | undefined) => v && Number.isFinite(Date.parse(v)) ? v : null;
  const actualStart = validDate(source.start), actualEnd = validDate(source.end);
  const budget = start && end ? Date.parse(end) - Date.parse(start) : NaN;
  const used = actualStart ? (actualEnd ? Date.parse(actualEnd) : now) - Date.parse(actualStart) : NaN;
  const percentage = budget > 0 && used >= 0 ? Math.round(used / budget * 100) : null;
  return [actualStart ? `开始时间：${fullLocalTime(actualStart)}` : "尚未开始或开始时间不可用", actualEnd ? `结束时间：${fullLocalTime(actualEnd)}` : "", `已用时：${formatDuration(actualStart, actualEnd, now)}`, `排期用时：${budget > 0 ? formatDuration(start!, end!) : "不可用"}`, percentage !== null ? `用时占比：${percentage}%${percentage > 100 ? `\n超出排期：${percentage - 100}%` : ""}` : "用时占比：不可用"].filter(Boolean).join("\n");
}
export function attachResourcePopover(trigger: HTMLElement, type: "conversation" | "pr" | "time", source: ResourceSource): void {
  trigger.removeAttribute("title");
  trigger.setAttribute("aria-haspopup", "dialog"); trigger.setAttribute("aria-expanded", "false");
  const panel = node("div", "", "resource-popover"); panel.id = `resource-popover-${++serial}`; panel.hidden = true;
  panel.dataset.resource = type;
  panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", type === "conversation" ? "对话信息" : type === "pr" ? "PR 信息" : "用时信息"); panel.tabIndex = -1;
  trigger.setAttribute("aria-controls", panel.id);
  let openTimer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let observer: ResizeObserver | undefined, titleSignature = "", bodySignature = "", requestId = 0, touchStart: { x: number; y: number } | null = null, longPressed = false;
  let suppressFocus = false;
  let pr: PRSnapshot | null = null;
  const identity = node("div", "", "resource-identity"), body = node("div", "", "resource-body");
  panel.append(identity, body);
  const position = () => {
    if (panel.hidden) return;
    const r = trigger.getBoundingClientRect(), height = window.innerHeight;
    panel.style.maxHeight = `${Math.max(40, height - 16)}px`;
    panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8))}px`;
    const availableAbove = r.top - 16, availableBelow = height - r.bottom - 16;
    const above = panel.scrollHeight <= availableAbove || (panel.scrollHeight > availableBelow && availableAbove >= availableBelow);
    panel.dataset.placement = above ? "above" : "below";
    panel.style.maxHeight = `${Math.max(40, above ? availableAbove : availableBelow)}px`;
    panel.style.top = `${Math.max(8, Math.min(height - panel.offsetHeight - 8, above ? r.top - panel.offsetHeight - 8 : r.bottom + 8))}px`;
  };
  const refresh = () => {
    if (!trigger.isConnected) { close(); return; }
    if (type === "conversation") {
      const output = source.output();
      const signature = JSON.stringify([source.thread, output?.thread_title]);
      if (signature !== titleSignature) { titleSignature = signature; identity.replaceChildren(copyRow("对话 ID", source.thread), copyRow("标题", output?.thread_title ?? null)); }
      const message = output?.text || (source.thread ? output?.state === "empty" ? "尚无助手消息" : "读取失败或暂不可用" : "尚未关联对话");
      const nextBody = JSON.stringify([output?.message_status, output?.stale, message]);
      if (nextBody !== bodySignature) {
        bodySignature = nextBody; const top = body.scrollTop;
        const heading = node("div", "", "resource-section-heading");
        heading.append(node("h3", "最新回复", "resource-heading"));
        if (output?.message_status === "in_progress") heading.append(badge("生成中", "live"));
        if (output?.stale) heading.append(badge("数据已过期", "warning"));
        body.replaceChildren(heading, node("div", message, "resource-message")); body.scrollTop = top;
      }
    } else if (type === "time") {
      const lines = timingText(source).split("\n");
      const heading = node("div", "", "resource-section-heading");
      heading.append(node("h3", "用时详情", "resource-heading"));
      heading.append(badge(source.end ? "已结束" : source.start ? "计时中" : "未开始", source.end ? "neutral" : source.start ? "live" : "neutral"));
      const list = node("dl", "", "resource-time-list");
      for (const line of lines) {
        const separator = line.indexOf("：");
        const label = separator < 0 ? line.startsWith("已用") ? "用时占比" : "开始时间" : line.slice(0, separator);
        const value = separator < 0 ? line : line.slice(separator + 1);
        const row = node("div", "", "resource-time-row");
        row.dataset.emphasis = label === "已用时" ? "elapsed" : label === "用时占比" ? "ratio" : "none";
        if (label === "超出排期") row.dataset.overrun = "true";
        row.append(node("dt", label), node("dd", value)); list.append(row);
      }
      body.replaceChildren(heading, list);
    }
    position();
  };
  const loadPR = async (force = false) => {
    clearTimeout(refreshTimer);
    const current = ++requestId;
    const loadingHeading = node("div", "", "resource-section-heading");
    loadingHeading.append(node("h3", pr?.data?.title || "PR 信息", "resource-pr-title"));
    const loadingRefresh = document.createElement("button"); loadingRefresh.type = "button"; loadingRefresh.className = "resource-icon-button resource-refresh-button"; loadingRefresh.setAttribute("aria-label", "刷新 PR 信息"); loadingRefresh.append(icon("refresh")); loadingHeading.append(loadingRefresh, attachTooltip(loadingRefresh, node("span", "刷新 PR 信息"), "刷新 PR 信息"));
    loadingRefresh.addEventListener("click", () => void loadPR(true));
    body.replaceChildren(loadingHeading, node("p", pr?.data ? `${pr.data.state} · CI ${pr.data.ci}\n刷新中…` : "加载中…", "resource-message"));
    try {
      const response = await fetch(`api/resource-details?kind=${source.kind}&id=${encodeURIComponent(source.id)}${force ? "&refresh=1" : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error("读取失败");
      const next = await response.json() as PRSnapshot;
      if (current !== requestId || panel.hidden) return;
      pr = next; identity.replaceChildren();
      if (next.loading) refreshTimer = setTimeout(() => { if (!panel.hidden) void loadPR(); }, 1000);
      if (next.data) {
        const numberRow = copyRow("PR 编号", String(next.data.number));
        const urlRow = copyRow("链接", next.data.url, next.data.url);
        const link = document.createElement("a"); link.href = next.data.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.className = "resource-link-button"; link.setAttribute("aria-label", "打开 PR"); link.append(icon("external")); const linkHint = attachTooltip(link, node("span", "打开 PR"), "打开 PR"); urlRow.append(link, linkHint);
        identity.append(numberRow, urlRow);
        const data = next.data;
        const heading = node("div", "", "resource-section-heading");
        heading.append(node("h3", data.title, "resource-pr-title"));
        const refresh = document.createElement("button"); refresh.type = "button"; refresh.className = "resource-icon-button resource-refresh-button"; refresh.setAttribute("aria-label", "刷新 PR 信息"); refresh.append(icon("refresh")); heading.append(refresh, attachTooltip(refresh, node("span", "刷新 PR 信息"), "刷新 PR 信息")); refresh.addEventListener("click", () => void loadPR(true));
        const states = node("div", "", "resource-states");
        states.append(badge(data.state === "MERGED" ? "已合并" : data.state === "CLOSED" ? "已关闭" : "待合并", data.state === "MERGED" ? "positive" : "neutral"), badge(`CI ${data.ci}`, data.ci === "成功" ? "positive" : data.ci === "失败" ? "negative" : data.ci === "运行中" ? "live" : "neutral"));
        const conflict = node("p", data.mergeable === "CONFLICTING" ? "存在合并冲突" : data.mergeable === "MERGEABLE" ? "无合并冲突" : "冲突状态未知", "resource-note");
        if (data.mergeable === "CONFLICTING") conflict.dataset.tone = "negative";
        const checks = node("div", "", "resource-checks");
        if (data.checks.length) {
          checks.append(node("h4", "检查结果", "resource-label"));
          for (const check of data.checks) {
            const value = String(check.conclusion || check.state || check.status || "UNKNOWN");
            const row = node("div", "", "resource-check-row");
            row.append(node("span", String(check.name || check.context || "检查")), badge(checkLabel(value), checkTone(value)));
            checks.append(row);
          }
        }
        const updated = node("p", `更新于 ${next.observed_at ? fullLocalTime(next.observed_at) : "未知"}${next.stale ? " · 已过期" : ""}${next.loading ? " · 刷新中" : ""}`, "resource-updated");
        body.replaceChildren(heading, states, conflict, checks, updated);
        if (next.error) body.append(node("p", next.error, "resource-error"));
      } else body.textContent = next.error || "尚未关联 PR";

    } catch { if (current === requestId && !panel.hidden) { body.textContent = `${pr?.data ? `${pr.data.title}\n${pr.data.state} · CI ${pr.data.ci}\n数据已过期\n` : ""}读取失败，请稍后重试`;
      if (!identity.querySelector("button[data-retry]")) { const retry = document.createElement("button"); retry.type = "button"; retry.dataset.retry = "true"; retry.textContent = "重试"; retry.addEventListener("click", () => void loadPR(true)); identity.append(retry); } } }
    position();
  };
  const cancel = () => { clearTimeout(openTimer); clearTimeout(closeTimer); };
  const close = (restore = false) => {
    cancel(); if (panel.hidden) return;
    panel.hidden = true; requestId++; clearTimeout(refreshTimer); observer?.disconnect(); panel.remove(); trigger.setAttribute("aria-expanded", "false");
    window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true);
    document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", keys, true);
    if (active?.close === close) active = null;
    if (restore) { suppressFocus = true; trigger.focus(); suppressFocus = false; cancel(); }
  };
  const open = () => {
    cancel(); if (!trigger.isConnected || !panel.hidden) return;
    document.dispatchEvent(new Event("resource-popover-open"));
    active?.close(); active = { close, refresh }; panel.hidden = false; document.body.append(panel); trigger.setAttribute("aria-expanded", "true");
    refresh(); if (type === "pr") void loadPR();
    window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", keys, true);
    if (typeof ResizeObserver !== "undefined") { observer = new ResizeObserver(position); observer.observe(panel); }
  };
  const scheduleClose = () => { clearTimeout(openTimer); clearTimeout(closeTimer); closeTimer = setTimeout(() => { if (!panel.contains(document.activeElement) && document.activeElement !== trigger) close(); }, 180); };
  const outside = (e: Event) => { if (!panel.contains(e.target as Node) && !trigger.contains(e.target as Node)) close(); };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(true); }
    else if (e.key === "Tab" && !e.shiftKey && document.activeElement === trigger) { e.preventDefault(); (panel.querySelector<HTMLElement>("button,a") ?? panel).focus(); }
  };
  trigger.addEventListener("pointerenter", e => { if (e.pointerType === "mouse") { cancel(); openTimer = setTimeout(open, 250); } });
  trigger.addEventListener("pointerleave", scheduleClose); panel.addEventListener("pointerenter", cancel); panel.addEventListener("pointerleave", scheduleClose);
  trigger.addEventListener("focus", () => { if (!touchStart && !suppressFocus) open(); });
  for (const target of [trigger, panel]) target.addEventListener("focusout", () => setTimeout(() => { if (!panel.contains(document.activeElement) && document.activeElement !== trigger) close(); }, 0));
  trigger.addEventListener("pointerdown", e => { if (e.pointerType !== "mouse") { touchStart = { x: e.clientX, y: e.clientY }; longPressed = false; openTimer = setTimeout(() => { longPressed = true; open(); }, 500); } });
  trigger.addEventListener("pointermove", e => { if (touchStart && Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y) > 10) { cancel(); touchStart = null; } });
  for (const name of ["pointerup", "pointercancel"]) trigger.addEventListener(name, () => { clearTimeout(openTimer); touchStart = null; });
  trigger.addEventListener("click", e => { if (longPressed) { e.preventDefault(); e.stopImmediatePropagation(); longPressed = false; } }, true);
  panel.addEventListener("click", e => e.stopPropagation());
}
