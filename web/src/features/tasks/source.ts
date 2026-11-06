import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from "react";

import { useOptionalProductionApi } from "@/app/providers";
import { useOptionalDemoRuntime } from "@/demo/context";
import type { TaskView } from "@/demo/types";
import { usePublishedProjectTaskSource } from "@/features/projects/production-source";

import { useOptionalDemoProjectTaskSource } from "./demo-store";
import type { ProjectTaskSource } from "./types";

const projectTaskSourceContext = createContext<ProjectTaskSource | null | undefined>(undefined);

function readTaskViews(storageKey: string): Record<string, TaskView> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value === "list" || value === "board" || value === "graph")
    ) as Record<string, TaskView>;
  } catch {
    return {};
  }
}

function writeTaskViews(storageKey: string, views: Record<string, TaskView>): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(views));
  } catch {
    // Local persistence is a preference; the API-backed source remains usable.
  }
}

function useUnsharedProjectTaskSource(allowFallback: boolean): ProjectTaskSource | null {
  const demoRuntime = useOptionalDemoRuntime();
  const demoSource = useOptionalDemoProjectTaskSource();
  const assembly = useOptionalProductionApi();
  const principalKey = assembly?.auth.principalId ?? "anonymous";
  const workspaceKey = assembly?.auth.workspaceId ?? "default";
  const storageKey = `loomhelm.task-views.v1.${workspaceKey}.${principalKey}`;
  const [taskViews, setTaskViews] = useState<Record<string, TaskView>>(() => readTaskViews(storageKey));
  const taskViewsRef = useRef(taskViews);
  const authenticated = assembly?.auth.status === "authenticated";

  useEffect(() => {
    if (!allowFallback) return;
    const next = readTaskViews(storageKey);
    taskViewsRef.current = next;
    setTaskViews(next);
  }, [allowFallback, storageKey]);

  const setTaskView = useCallback((scope: string, view: TaskView) => {
    if (!allowFallback) return;
    const next = { ...taskViewsRef.current, [scope]: view };
    taskViewsRef.current = next;
    writeTaskViews(storageKey, next);
    setTaskViews(next);
  }, [allowFallback, storageKey]);

  const productionSource = usePublishedProjectTaskSource({
    client: assembly?.client,
    enabled: allowFallback && !demoRuntime && authenticated,
    canCreateProjects: assembly?.permissions.canManageProjects ?? false,
    principalId: assembly?.auth.principalId,
    sessionGeneration: assembly?.auth.sessionGeneration,
    taskViews,
    setTaskView
  });

  if (!allowFallback) return null;
  if (demoSource) return demoSource;
  if (!assembly || !authenticated) return null;
  return productionSource;
}

export function resolveProjectTaskSourceProviderValue(
  explicitSource: ProjectTaskSource | null | undefined,
  inheritedSource: ProjectTaskSource | null | undefined,
  fallbackSource: ProjectTaskSource | null
): ProjectTaskSource | null {
  if (explicitSource !== undefined) return explicitSource;
  if (inheritedSource !== undefined) return inheritedSource;
  return fallbackSource;
}

/** Resolves an explicit source first, then the nearest root source, and only then the local fallback. */
export function ProjectTaskSourceProvider({ source, children }: { source?: ProjectTaskSource | null } & PropsWithChildren) {
  const inheritedSource = useContext(projectTaskSourceContext);
  const fallbackSource = useUnsharedProjectTaskSource(source === undefined && inheritedSource === undefined);
  const resolvedSource = resolveProjectTaskSourceProviderValue(source, inheritedSource, fallbackSource);
  return createElement(projectTaskSourceContext.Provider, { value: resolvedSource }, children);
}

/** Reads the nearest source provider; undefined means no provider exists, while null is an intentional unavailable source. */
export function useProjectTaskSourceContext(): ProjectTaskSource | null | undefined {
  return useContext(projectTaskSourceContext);
}

/** Reads a shared source when present and creates an unshared fallback only outside a provider tree. */
export function useOptionalProjectTaskSource(): ProjectTaskSource | null {
  const sharedSource = useProjectTaskSourceContext();
  const fallbackSource = useUnsharedProjectTaskSource(sharedSource === undefined);
  return sharedSource === undefined ? fallbackSource : sharedSource;
}
