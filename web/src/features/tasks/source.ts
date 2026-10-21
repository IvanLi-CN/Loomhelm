import { useEffect, useState } from "react";

import { useOptionalProductionApi } from "@/app/providers";
import { useOptionalDemoRuntime } from "@/demo/context";
import type { TaskView } from "@/demo/types";
import { usePublishedProjectTaskSource } from "@/features/projects/production-source";

import { useOptionalDemoProjectTaskSource } from "./demo-store";
import type { ProjectTaskSource } from "./types";

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

export function useOptionalProjectTaskSource(): ProjectTaskSource | null {
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
