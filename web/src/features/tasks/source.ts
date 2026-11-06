import { createContext, createElement, useContext, useEffect, useState, type PropsWithChildren } from "react";

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

function useUnsharedProjectTaskSource(): ProjectTaskSource | null {
  const demoRuntime = useOptionalDemoRuntime();
  const demoSource = useOptionalDemoProjectTaskSource();
  const assembly = useOptionalProductionApi();
  const principalKey = assembly?.auth.principalId ?? "anonymous";
  const workspaceKey = assembly?.auth.workspaceId ?? "default";
  const storageKey = `loomhelm.task-views.v1.${workspaceKey}.${principalKey}`;
  const [taskViews, setTaskViews] = useState<Record<string, TaskView>>(() => readTaskViews(storageKey));
  const authenticated = assembly?.auth.status === "authenticated";

  useEffect(() => {
    setTaskViews(readTaskViews(storageKey));
  }, [storageKey]);

  const productionSource = usePublishedProjectTaskSource({
    client: assembly?.client,
    enabled: !demoRuntime && authenticated,
    canCreateProjects: assembly?.permissions.canManageProjects ?? false,
    principalId: assembly?.auth.principalId,
    sessionGeneration: assembly?.auth.sessionGeneration,
    taskViews,
    setTaskView: (scope, view) => {
      setTaskViews((current) => {
        const next = { ...current, [scope]: view };
        writeTaskViews(storageKey, next);
        return next;
      });
    }
  });

  if (demoSource) return demoSource;
  if (!assembly || !authenticated) return null;
  return productionSource;
}

function ProjectTaskSourceContextProvider({ source, children }: { source: ProjectTaskSource | null } & PropsWithChildren) {
  return createElement(projectTaskSourceContext.Provider, { value: source }, children);
}

function ProductionProjectTaskSourceProvider({ children }: PropsWithChildren) {
  const source = useUnsharedProjectTaskSource();
  return createElement(projectTaskSourceContext.Provider, { value: source }, children);
}

export function ProjectTaskSourceProvider({ source, children }: { source?: ProjectTaskSource | null } & PropsWithChildren) {
  return source === undefined
    ? createElement(ProductionProjectTaskSourceProvider, null, children)
    : createElement(ProjectTaskSourceContextProvider, { source }, children);
}

export function useProjectTaskSourceContext(): ProjectTaskSource | null | undefined {
  return useContext(projectTaskSourceContext);
}

export function useOptionalProjectTaskSource(): ProjectTaskSource | null {
  return useUnsharedProjectTaskSource();
}
