import { DataSet } from "vis-data";
import { Timeline } from "vis-timeline/standalone";
import { defaultTimelineWindow } from "./timeline-window";
import { MAX_TIMELINE_SPAN_MS, type DashboardTab, type ViewState } from "./view-state";
import type { Task, View } from "./model";

type TimelineMode = "planned" | "actual";
type TimelineRange = { start?: Date; end?: Date };

type TimelineContext = {
  getData: () => View | null;
  getViewState: () => ViewState;
  setViewState: (value: ViewState) => void;
  syncUrl: () => void;
  element: <T extends HTMLElement>(id: string) => T;
  css: (name: string, fallback: string) => string;
  groupColor: (groupId: string | null) => string;
  stateColor: (state: string) => string;
  labels: Record<string, string>;
  taskPreview: (task: Task) => HTMLElement;
  showHoverPreview: (content: HTMLElement, anchor: HTMLElement | { x: number; y: number }) => void;
  hideHoverPreview: () => void;
  recordPointerType: (pointerType: string | null) => void;
  selectTask: (id: string) => void;
  taskContextMenu?: (event: MouseEvent, id: string, target: HTMLElement) => void;
};

function text(tag: string, value: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

function pointerTypeFromEvent(event: unknown): "mouse" | "touch" | "pen" | null {
  if (!event || typeof event !== "object") return null;
  const value = (event as { pointerType?: unknown }).pointerType;
  return value === "mouse" || value === "touch" || value === "pen" ? value : null;
}

function taskLabel(label: string, id: string): HTMLElement {
  const element = text("span", label); element.dataset.contextTask = id; element.tabIndex = 0; return element;
}

export function createTimelineController(context: TimelineContext) {
  let plannedTimeline: Timeline | null = null;
  let actualTimeline: Timeline | null = null;
  let plannedBounds: TimelineRange = {};
  let actualBounds: TimelineRange = {};
  let plannedWindow: { start: Date; end: Date } | null = null;
  let actualWindow: { start: Date; end: Date } | null = null;
  let plannedRenderSerial = 0;
  let actualRenderSerial = 0;
  const wheelTargets = new WeakMap<HTMLElement, { timeline: Timeline; mode: TimelineMode }>();
  const wheelBound = new WeakSet<HTMLElement>();
  const panBound = new WeakSet<HTMLElement>();

  const timelineWindow = (mode: TimelineMode): { start?: string; end?: string } => {
    const state = context.getViewState();
    const start = mode === "planned" ? state.plannedStart : state.actualStart;
    const end = mode === "planned" ? state.plannedEnd : state.actualEnd;
    return start && end ? { start, end } : {};
  };
  const validWindow = (start: Date, end: Date): boolean => {
    const startTime = start.getTime();
    const endTime = end.getTime();
    return Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime && endTime - startTime <= MAX_TIMELINE_SPAN_MS;
  };
  const setTimelineWindow = (mode: TimelineMode, start: string | null, end: string | null): void => {
    if (start && end && !validWindow(new Date(start), new Date(end))) return;
    const state = context.getViewState();
    context.setViewState({ ...state, ...(mode === "planned" ? { plannedStart: start, plannedEnd: end } : { actualStart: start, actualEnd: end }) });
    context.syncUrl();
  };
  const syncTimelineRange = (mode: TimelineMode, timeline: Timeline): void => {
    const range = timeline.getWindow();
    if (!range.start || !range.end) return;
    const windowRange = { start: new Date(range.start), end: new Date(range.end) };
    if (mode === "planned") plannedWindow = windowRange; else actualWindow = windowRange;
    setTimelineWindow(mode, windowRange.start.toISOString(), windowRange.end.toISOString());
  };
  const current = (): { mode: TimelineMode; timeline: Timeline | null } => {
    const tab = context.getViewState().tab;
    return tab === "planned" ? { mode: "planned", timeline: plannedTimeline } : { mode: "actual", timeline: actualTimeline };
  };
  const windowTarget = (mode: TimelineMode, timeline: Timeline): { start: Date; end: Date } | null => {
    const remembered = mode === "planned" ? plannedWindow : actualWindow;
    if (remembered) return remembered;
    const range = timeline.getWindow();
    return range.start && range.end ? { start: new Date(range.start), end: new Date(range.end) } : null;
  };
  const applyWindow = (mode: TimelineMode, timeline: Timeline, start: Date, end: Date, persist = true): void => {
    if (!validWindow(start, end)) return;
    const windowRange = { start: new Date(start), end: new Date(end) };
    if (mode === "planned") plannedWindow = windowRange; else actualWindow = windowRange;
    if (persist) setTimelineWindow(mode, start.toISOString(), end.toISOString());
    timeline.setWindow(start, end, { animation: false });
    timeline.redraw();
  };
  const adjustWindow = (direction: "in" | "out"): void => {
    const active = current();
    if (!active.timeline) return;
    const range = windowTarget(active.mode, active.timeline);
    if (!range) return;
    const span = Math.max(range.end.getTime() - range.start.getTime(), 30 * 60_000);
    const nextSpan = Math.max(30 * 60_000, span * (direction === "in" ? 0.5 : 2));
    const center = (range.start.getTime() + range.end.getTime()) / 2;
    applyWindow(active.mode, active.timeline, new Date(center - nextSpan / 2), new Date(center + nextSpan / 2));
  };
  const bindWheel = (target: HTMLElement, timeline: Timeline, mode: TimelineMode): void => {
    wheelTargets.set(target, { timeline, mode });
    if (wheelBound.has(target)) return;
    wheelBound.add(target);
    target.addEventListener("wheel", (event) => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      const active = wheelTargets.get(target);
      const center = target.querySelector<HTMLElement>(".vis-panel.vis-center");
      const range = active?.timeline.getWindow();
      const rect = center?.getBoundingClientRect();
      if (!active || !range?.start || !range.end || !rect || rect.width <= 0) return;
      const span = range.end.getTime() - range.start.getTime();
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const nextSpan = Math.max(1_000, span * (event.deltaY < 0 ? 0.8 : 1.25));
      const pointerTime = range.start.getTime() + span * ratio;
      event.preventDefault();
      event.stopPropagation();
      applyWindow(active.mode, active.timeline, new Date(pointerTime - nextSpan * ratio), new Date(pointerTime + nextSpan * (1 - ratio)));
    }, { capture: true, passive: false });
  };
  const bindPan = (target: HTMLElement, timeline: Timeline, mode: TimelineMode, renderSerial: number): void => {
    const center = target.querySelector<HTMLElement>(".vis-panel.vis-center");
    if (!center || panBound.has(center)) return;
    panBound.add(center);
    let pan: { pointerId: number; originX: number; originY: number; start: number; end: number; width: number; active: boolean } | null = null;
    const isCurrent = (): boolean => (mode === "planned" ? plannedTimeline : actualTimeline) === timeline && (mode === "planned" ? plannedRenderSerial : actualRenderSerial) === renderSerial;
    const finish = (event: PointerEvent): void => {
      if (!pan || event.pointerId !== pan.pointerId) return;
      if (pan.active && center.hasPointerCapture(event.pointerId)) center.releasePointerCapture(event.pointerId);
      center.classList.remove("is-panning");
      if (pan.active && isCurrent()) syncTimelineRange(mode, timeline);
      pan = null;
    };
    center.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0 || (event.target instanceof HTMLElement && event.target.closest(".vis-item"))) return;
      const range = timeline.getWindow();
      if (!range.start || !range.end || center.clientWidth <= 0) return;
      pan = { pointerId: event.pointerId, originX: event.clientX, originY: event.clientY, start: range.start.getTime(), end: range.end.getTime(), width: center.clientWidth, active: false };
    }, true);
    center.addEventListener("pointermove", (event) => {
      if (!pan || event.pointerId !== pan.pointerId || !isCurrent()) return;
      const deltaX = event.clientX - pan.originX;
      const deltaY = event.clientY - pan.originY;
      if (!pan.active) {
        if (Math.abs(deltaY) > Math.abs(deltaX)) { pan = null; return; }
        if (Math.abs(deltaX) < 4) return;
        pan.active = true;
        center.setPointerCapture(event.pointerId);
        center.classList.add("is-panning");
      }
      const shift = -deltaX * ((pan.end - pan.start) / pan.width);
      applyWindow(mode, timeline, new Date(pan.start + shift), new Date(pan.end + shift), false);
      event.preventDefault();
      event.stopPropagation();
    }, true);
    center.addEventListener("pointerup", finish, true);
    center.addEventListener("pointercancel", finish, true);
    center.addEventListener("lostpointercapture", finish, true);
  };
  const renderTimeline = (tasks: Task[], mode: TimelineMode): void => {
    const data = context.getData();
    if (!data) return;
    const renderSerial = mode === "planned" ? ++plannedRenderSerial : ++actualRenderSerial;
    const target = context.element<HTMLElement>(mode === "planned" ? "planned-timeline" : "actual-timeline");
    target.parentElement!.querySelector<HTMLElement>(".axis-timezone")!.textContent = `时间轴时区：${Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown"}`;
    const existing = mode === "planned" ? plannedTimeline : actualTimeline;
    existing?.destroy();
    target.replaceChildren();
    const includedTasks = new Set(tasks.map((task) => task.id));
    const nodes = data.nodes.filter((node) => node.kind !== "task" || !!node.ref_id && includedTasks.has(node.ref_id));
    const groups = new DataSet(nodes.map((node, index) => ({ id: node.id, content: node.kind === "task" && node.ref_id ? taskLabel(node.label, node.ref_id) : text("span", node.label), order: index })));
    const entries: any[] = [];
    const entryTasks = new Map<string, string>();
    const unknown: string[] = [];
    for (const task of tasks) {
      const node = data.nodes.find((item) => item.kind === "task" && item.ref_id === task.id);
      const planRow = data.planned_intervals.find((item) => item.node_id === node?.id);
      const actualRows = data.actual_intervals.filter((item) => item.task_id === task.id);
      if (mode === "planned") {
        if (planRow?.start && planRow.end && node) entries.push({ id: `plan-${task.id}`, task_id: task.id, group: node.id, start: planRow.start, end: planRow.end, content: text("span", task.title), style: `background-color: ${context.groupColor(node.planned_group_id ?? task.group_id)}; border-color: ${context.groupColor(node.planned_group_id ?? task.group_id)}; color: white;`, editable: false });
        else unknown.push(task.title);
      } else if (actualRows.length && node) actualRows.forEach((row, index) => { const color = context.stateColor(row.state); const group = data.groups.find((item) => item.id === row.group_id); const foreground = ["waiting", "planned"].includes(row.state) ? context.css("--text", "#172129") : "#ffffff"; entries.push({ id: `actual-${task.id}-${index}`, task_id: task.id, group: node.id, start: row.start, end: row.end ?? new Date().toISOString(), content: text("span", context.labels[row.state] ?? row.state), title: group?.title ?? row.group_id, style: `background-color: ${color}; border-color: ${color}; border-left: 4px solid ${context.groupColor(row.group_id)}; color: ${foreground};`, editable: false }); });
      else if (mode === "actual") unknown.push(task.title);
    }
    for (const node of nodes.filter((item) => item.kind !== "task")) { const planned = data.planned_intervals.find((item) => item.node_id === node.id); const date = mode === "planned" ? planned?.start : data.actual_milestones.find((item) => item.node_id === node.id)?.occurred_at; if (date) entries.push({ id: `milestone-${node.id}`, group: node.id, start: date, content: text("span", node.label), type: "box", style: `border-color: ${context.groupColor(node.planned_group_id)};`, editable: false }); else unknown.push(node.label); }
    const unknownElement = context.element(mode === "planned" ? "planned-unknown" : "actual-unknown");
    unknownElement.textContent = unknown.length ? `时间未知：${unknown.join("、")}` : "";
    for (const entry of entries) if (entry.task_id) entryTasks.set(entry.id, entry.task_id);
    const requestedWindow = timelineWindow(mode);
    const fittedWindow = defaultTimelineWindow(entries);
    if (mode === "planned") plannedBounds = fittedWindow; else actualBounds = fittedWindow;
    const initialWindow = requestedWindow.start && requestedWindow.end ? { start: new Date(requestedWindow.start), end: new Date(requestedWindow.end) } : fittedWindow.start && fittedWindow.end ? { start: fittedWindow.start, end: fittedWindow.end } : null;
    if (mode === "planned") plannedWindow = initialWindow; else actualWindow = initialWindow;
    target.style.height = `${Math.max(284, nodes.length * 28 + 76)}px`;
    const timeline = new Timeline(target, new DataSet(entries), groups, { editable: false, stack: false, groupOrder: "order", selectable: true, moveable: true, zoomable: true, horizontalScroll: false, zoomKey: "ctrlKey", ...(requestedWindow.start && requestedWindow.end ? requestedWindow : fittedWindow) });
    if (mode === "planned") plannedTimeline = timeline; else actualTimeline = timeline;
    bindWheel(target, timeline, mode);
    bindPan(target, timeline, mode, renderSerial);
    window.requestAnimationFrame(() => { const currentTimeline = mode === "planned" ? plannedTimeline : actualTimeline; const currentSerial = mode === "planned" ? plannedRenderSerial : actualRenderSerial; if (renderSerial !== currentSerial || currentTimeline !== timeline) return; timeline.redraw(); const root = target.querySelector<HTMLElement>(".vis-timeline"); if (root) root.style.visibility = "visible"; const loadingScreen = target.querySelector<HTMLElement>(".vis-loading-screen"); if (loadingScreen) { loadingScreen.hidden = true; loadingScreen.setAttribute("aria-hidden", "true"); } bindPan(target, timeline, mode, renderSerial); });
    target.oncontextmenu = (event) => {
      const properties = timeline.getEventProperties(event);
      const id = nodes.find(node => node.id === String(properties.group) && node.kind === "task")?.ref_id;
      if (id) context.taskContextMenu?.(event, id, target);
    };
    timeline.on("select", (event: { items: string[] }) => { const id = entryTasks.get(String(event.items[0] ?? "")); if (id) context.selectTask(id); });
    timeline.on("itemover", (event: { item: string; event?: MouseEvent }) => { const id = entryTasks.get(event.item); const task = id ? data.tasks.find((item) => item.id === id) : null; if (!task) return; context.recordPointerType(pointerTypeFromEvent(event.event)); const item = target.querySelector<HTMLElement>(`.vis-item[data-id="${CSS.escape(event.item)}"]`); const anchor = item ?? (event.event ? { x: event.event.clientX, y: event.event.clientY } : target); context.showHoverPreview(context.taskPreview(task), anchor); });
    timeline.on("itemout", context.hideHoverPreview);
    timeline.on("rangechanged", (event: { start: Date; end: Date; byUser?: boolean }) => { const currentTimeline = mode === "planned" ? plannedTimeline : actualTimeline; const currentSerial = mode === "planned" ? plannedRenderSerial : actualRenderSerial; if (timeline !== currentTimeline || renderSerial !== currentSerial || !event.byUser || !event.start || !event.end) return; const windowRange = { start: new Date(event.start), end: new Date(event.end) }; if (mode === "planned") plannedWindow = windowRange; else actualWindow = windowRange; setTimelineWindow(mode, windowRange.start.toISOString(), windowRange.end.toISOString()); });
  };
  return {
    renderTimeline,
    activeTimeline: () => current(),
    adjustWindow,
    fit: () => { const active = current(); const bounds = active.mode === "planned" ? plannedBounds : actualBounds; if (active.timeline && bounds.start && bounds.end) applyWindow(active.mode, active.timeline, bounds.start, bounds.end); },
    redraw: () => current().timeline?.redraw(),
  };
}
