import type { AgentOutput } from "./agent-output";
import type { View } from "./model";
import { formatDuration, fullLocalTime } from "./time";
import type { PRSnapshot } from "../scripts/pr-details";
let serial = 0;
let active: { close: (restore?: boolean) => void; refresh: () => void } | null = null;
export function refreshResourcePopover(): void { active?.refresh(); }
export function closeResourcePopover(): void { active?.close(); }
const node = (tag: string, value = "", className = "") => { const n = document.createElement(tag); n.textContent = value; n.className = className; return n; };
export type ResourceSource = { kind: "task" | "group"; id: string; thread: string | null; output: () => AgentOutput | undefined; start: string | null; end: string | null; view: View };
function copyRow(label: string, value: string | null): HTMLElement {
  const row = node("div", "", "resource-copy-row");
  row.append(node("span", `${label}：${value || "不可用"}`));
  if (value) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = `复制${label}`;
    button.addEventListener("click", async () => { try { await navigator.clipboard.writeText(value); button.textContent = "已复制"; } catch { button.textContent = "复制失败"; } });
    row.append(button);
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
  return [actualStart ? `开始时间：${fullLocalTime(actualStart)}` : "尚未开始或开始时间不可用", actualEnd ? `结束时间：${fullLocalTime(actualEnd)}` : "", `已用时：${formatDuration(actualStart, actualEnd, now)}`, `排期用时：${budget > 0 ? formatDuration(start!, end!) : "不可用"}`, percentage !== null ? `已用${percentage}%${percentage > 100 ? `，超出${percentage - 100}%` : ""}` : "用时占比：不可用"].filter(Boolean).join("\n");
}
export function attachResourcePopover(trigger: HTMLElement, type: "conversation" | "pr" | "time", source: ResourceSource): void {
  trigger.removeAttribute("title");
  trigger.setAttribute("aria-haspopup", "dialog"); trigger.setAttribute("aria-expanded", "false");
  const panel = node("div", "", "resource-popover"); panel.id = `resource-popover-${++serial}`; panel.hidden = true;
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
      const nextBody = `${output?.message_status === "in_progress" ? "生成中\n" : ""}${output?.stale ? "数据已过期\n" : ""}${message}`;
      if (nextBody !== bodySignature) { bodySignature = nextBody; const top = body.scrollTop; body.textContent = nextBody; body.scrollTop = top; }
    } else if (type === "time") { body.textContent = timingText(source); }
    position();
  };
  const loadPR = async (force = false) => {
    clearTimeout(refreshTimer);
    const current = ++requestId;
    body.textContent = pr?.data ? `${pr.data.state} · CI ${pr.data.ci}\n${pr.data.title}\n刷新中…` : "加载中…";
    try {
      const response = await fetch(`api/resource-details?kind=${source.kind}&id=${encodeURIComponent(source.id)}${force ? "&refresh=1" : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error("读取失败");
      const next = await response.json() as PRSnapshot;
      if (current !== requestId || panel.hidden) return;
      pr = next; identity.replaceChildren();
      if (next.loading) refreshTimer = setTimeout(() => { if (!panel.hidden) void loadPR(); }, 1000);
      if (next.data) {
        identity.append(copyRow("PR 编号", String(next.data.number)), copyRow("链接", next.data.url));
        const link = document.createElement("a"); link.href = next.data.url; link.rel = "noopener noreferrer"; link.textContent = "打开 PR"; identity.append(link);
        body.textContent = `${next.data.title}\n${next.data.state} · ${next.data.mergeable === "CONFLICTING" ? "存在合并冲突" : next.data.mergeable === "MERGEABLE" ? "无合并冲突" : "冲突状态未知"}\nCI：${next.data.ci}\n${next.data.checks.map(c => `${c.name || c.context || "检查"}：${c.conclusion || c.state || c.status || "未知"}`).join("\n")}\n更新时间：${next.observed_at ? fullLocalTime(next.observed_at) : "未知"}${next.stale ? "（已过期）" : ""}${next.error ? `\n${next.error}` : ""}`;
      } else body.textContent = next.error || "尚未关联 PR";
      const button = document.createElement("button"); button.type = "button"; button.textContent = "刷新"; button.addEventListener("click", () => void loadPR(true)); identity.append(button);
    } catch { if (current === requestId && !panel.hidden) { body.textContent = `${pr?.data ? `${pr.data.title}\n${pr.data.state} · CI ${pr.data.ci}\n数据已过期\n` : ""}读取失败，请稍后重试`; } }
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
