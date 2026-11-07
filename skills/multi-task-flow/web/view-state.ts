export type DashboardTab = "graph" | "planned" | "actual";
export type TaskLayout = "board" | "grid";
export type Selection = { kind: "task" | "group"; id: string };

export type ViewState = {
  tab: DashboardTab;
  layout: TaskLayout;
  query: string;
  group: string;
  state: string;
  kind: string;
  plan: string | null;
  selected: Selection | null;
  detail: boolean;
  zoom: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
};

export const DEFAULT_VIEW_STATE: ViewState = {
  tab: "graph", layout: "board", query: "", group: "", state: "", kind: "", plan: null,
  selected: null, detail: false, zoom: 1, plannedStart: null, plannedEnd: null,
  actualStart: null, actualEnd: null,
};

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const tabs = new Set<DashboardTab>(["graph", "planned", "actual"]);
const taskLayouts = new Set<TaskLayout>(["board", "grid"]);

export function defaultTaskLayout(groupCount: number): TaskLayout {
  return groupCount === 1 ? "grid" : "board";
}

export function hasValidLayoutParam(search: string): boolean {
  return taskLayouts.has(new URLSearchParams(search).get("layout") as TaskLayout);
}
const zoomBounds = { min: 0.2, max: 2.5 };
export const MAX_TIMELINE_SPAN_MS = 10_000 * 365.25 * 24 * 60 * 60 * 1000;

export type ViewStateValidation = {
  groups?: ReadonlySet<string>;
  states?: ReadonlySet<string>;
  kinds?: ReadonlySet<string>;
  plans?: ReadonlySet<string>;
  tasks?: ReadonlySet<string>;
};

export type ViewStateHistory = {
  replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
};

function validId(value: string | null): string | null {
  return value && idPattern.test(value) ? value : null;
}

function validValue(value: string | null, allowed?: ReadonlySet<string>): string {
  if (!value || !validId(value)) return "";
  return allowed && !allowed.has(value) ? "" : value;
}

function validDate(value: string | null): string | null {
  if (!value || value.length > 64 || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function validDateRange(start: string | null, end: string | null): [string | null, string | null] {
  const normalizedStart = validDate(start);
  const normalizedEnd = validDate(end);
  if (!normalizedStart || !normalizedEnd || Date.parse(normalizedStart) >= Date.parse(normalizedEnd) || Date.parse(normalizedEnd) - Date.parse(normalizedStart) > MAX_TIMELINE_SPAN_MS) return [null, null];
  return [normalizedStart, normalizedEnd];
}

function parseSelection(value: string | null, validation: ViewStateValidation): Selection | null {
  if (!value) return null;
  const match = /^(task|group):([A-Za-z0-9_-]{1,128})$/.exec(value);
  if (!match) return null;
  const id = validId(match[2] ?? null);
  if (!id) return null;
  if (match[1] === "task" && validation.tasks && !validation.tasks.has(id)) return null;
  if (match[1] === "group" && validation.groups && !validation.groups.has(id)) return null;
  return { kind: match[1] as Selection["kind"], id };
}

export function parseViewState(search: string, validation: ViewStateValidation = {}): ViewState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const rawZoom = Number(params.get("zoom"));
  const zoom = Number.isFinite(rawZoom) && rawZoom >= zoomBounds.min && rawZoom <= zoomBounds.max ? Math.round(rawZoom * 100) / 100 : DEFAULT_VIEW_STATE.zoom;
  const tab = tabs.has(params.get("tab") as DashboardTab) ? params.get("tab") as DashboardTab : DEFAULT_VIEW_STATE.tab;
  const layout = taskLayouts.has(params.get("layout") as TaskLayout) ? params.get("layout") as TaskLayout : defaultTaskLayout(validation.groups?.size ?? 0);
  const selected = parseSelection(params.get("selected"), validation);
  const [plannedStart, plannedEnd] = validDateRange(params.get("plannedStart"), params.get("plannedEnd"));
  const [actualStart, actualEnd] = validDateRange(params.get("actualStart"), params.get("actualEnd"));
  return {
    tab,
    layout,
    query: (params.get("q") ?? "").slice(0, 200),
    group: validValue(params.get("group"), validation.groups),
    state: validValue(params.get("state"), validation.states),
    kind: validValue(params.get("kind"), validation.kinds),
    plan: validValue(params.get("plan"), validation.plans) || null,
    selected,
    detail: ["1", "true"].includes(params.get("detail") ?? "") && selected !== null,
    zoom,
    plannedStart,
    plannedEnd,
    actualStart,
    actualEnd,
  };
}

export function restoreViewState(search: string, validation: ViewStateValidation = {}, phase: "planning" | "execution" | null = null): ViewState {
  const state = parseViewState(search, validation);
  return !hasValidTabParam(search) && phase === "execution" ? { ...state, tab: "actual" } : state;
}

export function hasValidTabParam(search: string): boolean {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return tabs.has(params.get("tab") as DashboardTab);
}

export function restoreViewStateForNavigation(search: string, validation: ViewStateValidation = {}, phase: "planning" | "execution" | null = null): { state: ViewState; hasExplicitTab: boolean } {
  return { state: restoreViewState(search, validation, phase), hasExplicitTab: hasValidTabParam(search) };
}

export function sanitizeViewState(state: ViewState, validation: ViewStateValidation): ViewState {
  const selected = state.selected && parseSelection(`${state.selected.kind}:${state.selected.id}`, validation);
  return {
    ...state,
    layout: taskLayouts.has(state.layout) ? state.layout : DEFAULT_VIEW_STATE.layout,
    group: validValue(state.group, validation.groups),
    state: validValue(state.state, validation.states),
    kind: validValue(state.kind, validation.kinds),
    plan: validValue(state.plan, validation.plans) || null,
    selected,
    detail: state.detail && selected !== null,
  };
}

export function serializeViewState(state: ViewState, defaultPlan: string | null = null, defaultTab: DashboardTab = DEFAULT_VIEW_STATE.tab, defaultLayout: TaskLayout = DEFAULT_VIEW_STATE.layout): string {
  const params = new URLSearchParams();
  if (state.tab !== defaultTab) params.set("tab", state.tab);
  if (state.layout !== defaultLayout) params.set("layout", state.layout);
  if (state.query) params.set("q", state.query);
  if (state.group) params.set("group", state.group);
  if (state.state) params.set("state", state.state);
  if (state.kind) params.set("kind", state.kind);
  if (state.plan && state.plan !== defaultPlan) params.set("plan", state.plan);
  if (state.selected) params.set("selected", `${state.selected.kind}:${state.selected.id}`);
  if (state.detail && state.selected) params.set("detail", "1");
  if (state.plannedStart) params.set("plannedStart", state.plannedStart);
  if (state.plannedEnd) params.set("plannedEnd", state.plannedEnd);
  if (state.actualStart) params.set("actualStart", state.actualStart);
  if (state.actualEnd) params.set("actualEnd", state.actualEnd);
  return params.toString();
}

export function canonicalViewUrl(currentUrl: string, state: ViewState, defaultPlan: string | null = null, defaultTab: DashboardTab = DEFAULT_VIEW_STATE.tab, defaultLayout: TaskLayout = DEFAULT_VIEW_STATE.layout): string {
  const url = new URL(currentUrl);
  const query = serializeViewState(state, defaultPlan, defaultTab, defaultLayout);
  url.search = query ? `?${query}` : "";
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString();
}

export function replaceViewStateOn(history: ViewStateHistory, currentUrl: string, state: ViewState, defaultPlan: string | null = null, defaultTab: DashboardTab = DEFAULT_VIEW_STATE.tab, defaultLayout: TaskLayout = DEFAULT_VIEW_STATE.layout): string {
  const nextUrl = canonicalViewUrl(currentUrl, state, defaultPlan, defaultTab, defaultLayout);
  history.replaceState(null, "", nextUrl);
  return nextUrl;
}

export function replaceViewState(state: ViewState, defaultPlan: string | null = null, defaultTab: DashboardTab = DEFAULT_VIEW_STATE.tab, defaultLayout: TaskLayout = DEFAULT_VIEW_STATE.layout): void {
  replaceViewStateOn(window.history, window.location.href, state, defaultPlan, defaultTab, defaultLayout);
}

export function selectionFromState(state: ViewState): Selection | null { return state.selected; }
