import {
  createFixturesForState
} from "./fixtures";
import {
  demoDataModes,
  demoNetworks,
  demoPersonas,
  demoScenes,
  themeModes,
  type DemoBootstrapSnapshot,
  type DemoDataMode,
  type DemoNetwork,
  type DemoPersona,
  type DemoQueryState,
  type DemoScene,
  type ThemeMode
} from "./types";

const demoStoragePrefix = "loomhelm.demo.v1";

function oneOf<T extends readonly string[]>(values: T, value: string | null, fallback: T[number]): T[number] {
  return value && values.includes(value) ? value as T[number] : fallback;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(`${demoStoragePrefix}.${key}`);
  } catch {
    return null;
  }
}

function parseQuery(search: string): Required<DemoQueryState> {
  const query = new URLSearchParams(search);
  return {
    scene: oneOf(demoScenes, query.get("demo"), "normal") as DemoScene,
    persona: oneOf(demoPersonas, query.get("d_persona"), "owner") as DemoPersona,
    network: oneOf(demoNetworks, query.get("d_network"), "online") as DemoNetwork,
    dataMode: oneOf(demoDataModes, query.get("d_data"), "full") as DemoDataMode,
    theme: oneOf(themeModes, query.get("d_theme") ?? readStorage("theme"), "system") as ThemeMode
  };
}

function readTaskViews(): Record<string, "list" | "board" | "graph"> {
  try {
    const raw = window.localStorage.getItem(`${demoStoragePrefix}.task-views`);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value === "list" || value === "board" || value === "graph")
    ) as Record<string, "list" | "board" | "graph">;
  } catch {
    return {};
  }
}

function readDrafts(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(`${demoStoragePrefix}.drafts`);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function bootstrapDemo(): Promise<DemoBootstrapSnapshot> {
  // This explicit boundary runs before RouterProvider, queries, auth, or stream setup.
  const query = new URLSearchParams(window.location.search);
  if (query.get("d_bootstrap") === "fail") {
    throw new Error("Demo bootstrap was intentionally stopped by the selected fixture.");
  }

  const state = parseQuery(window.location.search);
  await Promise.resolve();

  return {
    ...state,
    taskViews: readTaskViews(),
    drafts: readDrafts(),
    fixtures: createFixturesForState(
      state.persona ?? "owner",
      state.dataMode ?? "full",
      state.scene === "permission-changed"
    )
  };
}

export function demoStorageKey(key: string): string {
  return `${demoStoragePrefix}.${key}`;
}

export function isDemoPath(pathname = window.location.pathname): boolean {
  return import.meta.env.MODE === "demo" || pathname === "/demo" || pathname.startsWith("/demo/");
}
