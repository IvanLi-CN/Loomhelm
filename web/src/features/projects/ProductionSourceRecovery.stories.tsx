import type { GeneratedApiClient } from "@loomhelm/api-client";
import type { Project, ProjectMember, Task, TaskRelationshipPage } from "@loomhelm/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useEffect, useMemo, useState } from "react";

import { usePublishedProjectTaskSource, type MutationNotice } from "./production-source";

const meta = {
  title: "Product/ProductionSourceRecovery",
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"]
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;
type Scenario = "persistence-failure" | "remote-refresh" | "remote-refresh-failure" | "identity-mismatch" | "stale-generation-create";

const principalId = "story-production-recovery-user";
const projectId = "project_0123456789abcdef0123456789abcdef";
const taskId = "task_0123456789abcdef0123456789abcdef";
const parentTaskId = "task_abcdefabcdefabcdefabcdefabcdefab";
const noticeId = "task:task_0123456789abcdef0123456789abcdef:mutation:story";

const project: Project = {
  id: projectId,
  name: "Recovery project",
  description: "Production source acceptance",
  created_at: "2026-10-23T00:00:00Z",
  updated_at: "2026-10-23T00:00:00Z"
};
const member: ProjectMember = {
  project_id: projectId,
  user_id: principalId,
  role: "owner",
  created_at: "2026-10-23T00:00:00Z"
};

const task: Task = {
  id: taskId,
  project_id: projectId,
  title: "Recovery task",
  goal: "Keep writes blocked until a complete refresh finishes.",
  status: "todo",
  updated_at: "2026-10-23T00:00:00Z",
  created_at: "2026-10-23T00:00:00Z"
};

const parentTask: Task = {
  ...task,
  id: parentTaskId,
  title: "Parent task"
};

const emptyRelationships: TaskRelationshipPage = {
  parents: [],
  children: [],
  prerequisites: [],
  dependents: []
};

interface ScenarioState {
  scenario: Scenario;
  principalId: string;
  sessionGeneration: number;
  projectListCalls: number;
  createCalls: number;
  createTaskCalls: number;
  updateCalls: number;
  relationCalls: number;
  dependencyCalls: number;
  requestedTaskId: string;
  refreshRequested: boolean;
  refreshState: "idle" | "pending" | "failed" | "complete";
  lastResult: string;
  notify?: () => void;
  listeners?: Set<() => void>;
  resolveRefresh?: () => void;
  resolveProjectCreate?: () => void;
  resolveTaskCreate?: () => void;
  createdProject?: Project;
  createdTask?: Task;
  broadcastDescriptor?: PropertyDescriptor;
  locksDescriptor?: PropertyDescriptor;
  setItemDescriptor?: PropertyDescriptor;
  broadcastPatched: boolean;
  locksPatched: boolean;
  setItemPatched: boolean;
}

function notifyScenario(state: ScenarioState): void {
  state.notify?.();
  state.listeners?.forEach((listener) => listener());
}

function mutationNoticeKey(id: string): string {
  return `loomhelm.project-task.mutation-notice.v2.${encodeURIComponent(principalId)}.${encodeURIComponent(id)}`;
}

const remoteNotice: MutationNotice = {
  id: noticeId,
  message: "远端任务结果待确认。",
  kind: "reconciliation",
  taskId,
  lockScope: `task:${taskId}`
};

function clearScenarioStorage(): void {
  const prefix = `loomhelm.project-task.mutation-notice.v2.${encodeURIComponent(principalId)}.`;
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(prefix)) window.localStorage.removeItem(key);
  }
}

function prepareScenario(state: ScenarioState): void {
  clearScenarioStorage();
  if (state.scenario === "remote-refresh" || state.scenario === "remote-refresh-failure" || state.scenario === "stale-generation-create") {
    state.broadcastDescriptor = Object.getOwnPropertyDescriptor(window, "BroadcastChannel");
    Object.defineProperty(window, "BroadcastChannel", { configurable: true, value: undefined });
    state.broadcastPatched = true;
    window.localStorage.setItem(mutationNoticeKey(noticeId), JSON.stringify(remoteNotice));
  }

  state.locksDescriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  try {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (_name: string, _options: unknown, callback: (lock: { name: string }) => Promise<unknown>) => callback({ name: "story-lock" }),
        query: async () => ({ held: [], pending: [] })
      }
    });
    state.locksPatched = true;
  } catch {
    state.locksPatched = false;
  }

  if (state.scenario === "persistence-failure") {
    state.setItemDescriptor = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem");
    try {
      Object.defineProperty(Storage.prototype, "setItem", { configurable: true, value: () => { throw new Error("storage blocked"); } });
      state.setItemPatched = true;
    } catch {
      state.setItemPatched = false;
    }
  }
}

function restoreScenario(state: ScenarioState): void {
  if (state.setItemPatched && state.setItemDescriptor) Object.defineProperty(Storage.prototype, "setItem", state.setItemDescriptor);
  if (state.locksPatched) {
    if (state.locksDescriptor) Object.defineProperty(navigator, "locks", state.locksDescriptor);
    else delete (navigator as { locks?: unknown }).locks;
  }
  if (state.broadcastPatched) {
    if (state.broadcastDescriptor) Object.defineProperty(window, "BroadcastChannel", state.broadcastDescriptor);
    else delete (window as Window & { BroadcastChannel?: unknown }).BroadcastChannel;
  }
  clearScenarioStorage();
}

function createClient(state: ScenarioState): GeneratedApiClient {
  return {
    listProjects: async () => {
      state.projectListCalls += 1;
      if (state.refreshRequested) {
        state.refreshRequested = false;
        state.refreshState = "pending";
        notifyScenario(state);
        if (state.scenario === "remote-refresh-failure") {
          state.refreshState = "failed";
          notifyScenario(state);
          throw new Error("刷新项目失败");
        }
        return new Promise((resolve) => {
          state.resolveRefresh = () => {
            state.resolveRefresh = undefined;
            resolve({ items: [project], has_more: false });
          };
        });
      }
      return { items: state.createdProject ? [project, state.createdProject] : [project], has_more: false };
    },
    listProjectMembers: async ({ project_id }: { project_id?: string }) => ({ items: [{ ...member, project_id: project_id ?? projectId }], has_more: false }),
    listTasks: async () => {
      if (state.refreshState === "pending") {
        state.refreshState = "complete";
        notifyScenario(state);
      }
      return { items: state.createdTask ? [task, parentTask, state.createdTask] : [task, parentTask], has_more: false };
    },
    getTaskRelationships: async () => emptyRelationships,
    createProject: async ({ body }: { body: { id?: string; name?: string; description?: string } }) => {
      state.createCalls += 1;
      notifyScenario(state);
      if (state.scenario === "stale-generation-create") {
        return new Promise((resolve) => {
          state.resolveProjectCreate = () => {
            const created = { ...project, id: body.id ?? project.id, name: body.name ?? project.name, description: body.description ?? project.description };
            state.createdProject = created;
            state.resolveProjectCreate = undefined;
            resolve({ project: created });
          };
        });
      }
      return { project };
    },
    updateTask: async ({ body }: { body: { title?: string } }) => {
      state.updateCalls += 1;
      notifyScenario(state);
      return { task: { ...task, title: body.title ?? task.title } };
    },
    getProject: async () => ({ project }),
    updateProject: async () => ({ project }),
    deleteProject: async () => undefined,
    createTask: async ({ body }: { body: { id?: string } }) => {
      state.createTaskCalls += 1;
      state.requestedTaskId = body.id ?? "";
      notifyScenario(state);
      if (state.scenario === "stale-generation-create") {
        return new Promise((resolve) => {
          state.resolveTaskCreate = () => {
            const created = { ...task, id: body.id ?? task.id };
            state.createdTask = created;
            state.resolveTaskCreate = undefined;
            resolve({ task: created });
          };
        });
      }
      if (state.scenario === "identity-mismatch") {
        return { task: { ...task, id: "task_fedcfedcfedcfedcfedcfedcfedcfedc" } };
      }
      return { task };
    },
    getTask: async () => ({ task }),
    deleteTask: async () => undefined,
    addTaskParent: async () => {
      state.relationCalls += 1;
      notifyScenario(state);
    },
    removeTaskParent: async () => undefined,
    addTaskDependency: async () => {
      state.dependencyCalls += 1;
      notifyScenario(state);
    },
    removeTaskDependency: async () => undefined,
    grantProjectMember: async () => ({ member }),
    revokeProjectMember: async () => undefined
  } as unknown as GeneratedApiClient;
}

function RecoveryHarness({ state }: { state: ScenarioState }) {
  const queryClient = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }), []);
  return <QueryClientProvider client={queryClient}><RecoveryContent state={state} /></QueryClientProvider>;
}

function SharedRefreshHarness() {
  const state = useMemo(() => {
    const next: ScenarioState = {
      scenario: "remote-refresh-failure",
      principalId,
      sessionGeneration: 1,
      projectListCalls: 0,
      createCalls: 0,
      createTaskCalls: 0,
      updateCalls: 0,
      relationCalls: 0,
      dependencyCalls: 0,
      requestedTaskId: "",
      refreshRequested: false,
      refreshState: "idle",
      lastResult: "",
      broadcastPatched: false,
      locksPatched: false,
      setItemPatched: false,
      listeners: new Set()
    };
    prepareScenario(next);
    return next;
  }, []);
  const queryClient = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }), []);
  const [secondaryRevision, setSecondaryRevision] = useState(0);
  const [, setScenarioRevision] = useState(0);

  useEffect(() => {
    const listener = () => setScenarioRevision((value) => value + 1);
    state.listeners?.add(listener);
    return () => {
      state.listeners?.delete(listener);
    };
  }, [state]);

  useEffect(() => () => restoreScenario(state), [state]);

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-[var(--canvas)] p-8" data-visual-evidence-surface>
        <div className="mx-auto grid max-w-3xl gap-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-6" data-visual-evidence-target>
          <h1 className="text-lg font-semibold">Shared remote refresh barrier</h1>
          <p data-testid="shared-refresh-state">刷新：{state.refreshState}</p>
          <p data-testid="shared-update-calls">任务 PATCH：{state.updateCalls}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <SharedRefreshContent state={state} instance="主实例" />
            <SharedRefreshContent key={`secondary-${secondaryRevision}`} state={state} instance="副本实例" />
          </div>
          <button type="button" className="button button-secondary" onClick={() => setSecondaryRevision((value) => value + 1)}>重挂载副本实例</button>
        </div>
      </div>
    </QueryClientProvider>
  );
}

function SharedRefreshContent({ state, instance }: { state: ScenarioState; instance: string }) {
  const source = usePublishedProjectTaskSource({
    client: useMemo(() => createClient(state), [state]),
    enabled: true,
    canCreateProjects: true,
    principalId: state.principalId
  });
  const [, setRevision] = useState(0);

  useEffect(() => {
    const listener = () => setRevision((value) => value + 1);
    state.listeners?.add(listener);
    return () => {
      state.listeners?.delete(listener);
    };
  }, [state]);

  const triggerRemoteRemoval = () => {
    const key = mutationNoticeKey(noticeId);
    const oldValue = JSON.stringify(remoteNotice);
    state.refreshRequested = true;
    window.localStorage.removeItem(key);
    window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue: null, storageArea: window.localStorage, url: window.location.href }));
  };

  const runUpdate = async () => {
    const result = await source.updateTask(taskId, { title: "Updated task" });
    state.lastResult = result.ok ? "updated" : result.message;
    notifyScenario(state);
  };

  return (
    <section className="grid gap-2 rounded-lg border border-[var(--line)] p-4" aria-label={instance}>
      <h2 className="font-semibold">{instance}</h2>
      <p data-testid={`${instance}-status`}>状态：{source.status}</p>
      <p data-testid={`${instance}-result`}>结果：{state.lastResult || "无"}</p>
      {instance === "主实例" && <button type="button" className="button button-secondary" onClick={triggerRemoteRemoval}>主实例移除远端通知</button>}
      <button type="button" className="button button-secondary" onClick={() => { void runUpdate(); }}>{instance}尝试更新任务</button>
    </section>
  );
}

function GenerationRefreshHarness() {
  const state = useMemo(() => {
    const next: ScenarioState = {
      scenario: "remote-refresh",
      principalId,
      sessionGeneration: 1,
      projectListCalls: 0,
      createCalls: 0,
      createTaskCalls: 0,
      updateCalls: 0,
      relationCalls: 0,
      dependencyCalls: 0,
      requestedTaskId: "",
      refreshRequested: false,
      refreshState: "idle",
      lastResult: "",
      broadcastPatched: false,
      locksPatched: false,
      setItemPatched: false,
      listeners: new Set()
    };
    prepareScenario(next);
    return next;
  }, []);
  const queryClient = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }), []);
  const [, setRevision] = useState(0);

  useEffect(() => {
    const listener = () => setRevision((value) => value + 1);
    state.listeners?.add(listener);
    return () => {
      state.listeners?.delete(listener);
    };
  }, [state]);

  useEffect(() => () => restoreScenario(state), [state]);

  return <QueryClientProvider client={queryClient}><GenerationRefreshContent state={state} /></QueryClientProvider>;
}

function GenerationRefreshContent({ state }: { state: ScenarioState }) {
  const source = usePublishedProjectTaskSource({
    client: useMemo(() => createClient(state), [state]),
    enabled: true,
    canCreateProjects: true,
    principalId: state.principalId,
    sessionGeneration: state.sessionGeneration
  });
  const [, setRevision] = useState(0);

  useEffect(() => {
    const listener = () => setRevision((value) => value + 1);
    state.listeners?.add(listener);
    return () => {
      state.listeners?.delete(listener);
    };
  }, [state]);

  const triggerRemoteRemoval = () => {
    const key = mutationNoticeKey(noticeId);
    const oldValue = JSON.stringify(remoteNotice);
    state.refreshRequested = true;
    window.localStorage.removeItem(key);
    window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue: null, storageArea: window.localStorage, url: window.location.href }));
  };

  const revalidateSamePrincipal = () => {
    state.sessionGeneration += 1;
    notifyScenario(state);
  };

  const completeOldRefresh = () => {
    state.resolveRefresh?.();
  };

  const refreshCurrentGeneration = async () => {
    await source.refresh();
    state.lastResult = "current-refresh-complete";
    notifyScenario(state);
  };

  const runUpdate = async () => {
    const result = await source.updateTask(taskId, { title: "Updated task" });
    state.lastResult = result.ok ? "updated" : result.message;
    notifyScenario(state);
  };

  return (
    <div className="min-h-screen bg-[var(--canvas)] p-8" data-visual-evidence-surface>
      <div className="mx-auto grid max-w-3xl gap-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-6" data-visual-evidence-target>
        <h1 className="text-lg font-semibold">Same-principal generation refresh barrier</h1>
        <p data-testid="generation-value">认证代次：{state.sessionGeneration}</p>
        <p data-testid="generation-refresh-state">刷新：{state.refreshState}</p>
        <p data-testid="generation-update-calls">任务 PATCH：{state.updateCalls}</p>
        <p data-testid="generation-result">结果：{state.lastResult || "无"}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <button type="button" className="button button-secondary" onClick={triggerRemoteRemoval}>移除远端通知</button>
          <button type="button" className="button button-secondary" onClick={revalidateSamePrincipal}>同身份重新认证</button>
          <button type="button" className="button button-secondary" onClick={completeOldRefresh}>完成旧代刷新</button>
          <button type="button" className="button button-secondary" onClick={() => { void refreshCurrentGeneration(); }}>当前代刷新并核对</button>
          <button type="button" className="button button-secondary" onClick={() => { void runUpdate(); }}>尝试更新任务</button>
        </div>
      </div>
    </div>
  );
}

type StaleCreateKind = "project" | "task";

function StaleGenerationCreateHarness({ kind }: { kind: StaleCreateKind }) {
  const state = useMemo(() => {
    const next: ScenarioState = {
      scenario: "stale-generation-create",
      principalId,
      sessionGeneration: 1,
      projectListCalls: 0,
      createCalls: 0,
      createTaskCalls: 0,
      updateCalls: 0,
      relationCalls: 0,
      dependencyCalls: 0,
      requestedTaskId: "",
      refreshRequested: false,
      refreshState: "idle",
      lastResult: "",
      broadcastPatched: false,
      locksPatched: false,
      setItemPatched: false,
      listeners: new Set()
    };
    prepareScenario(next);
    return next;
  }, []);
  const queryClient = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }), []);
  const [, setRevision] = useState(0);

  useEffect(() => {
    const listener = () => setRevision((value) => value + 1);
    state.listeners?.add(listener);
    return () => {
      state.listeners?.delete(listener);
    };
  }, [state]);

  useEffect(() => () => restoreScenario(state), [state]);

  return <QueryClientProvider client={queryClient}><StaleGenerationCreateContent state={state} kind={kind} /></QueryClientProvider>;
}

function StaleGenerationCreateContent({ state, kind }: { state: ScenarioState; kind: StaleCreateKind }) {
  const [, setRevision] = useState(0);
  const source = usePublishedProjectTaskSource({
    client: useMemo(() => createClient(state), [state]),
    enabled: true,
    canCreateProjects: true,
    principalId: state.principalId,
    sessionGeneration: state.sessionGeneration
  });
  const resourceId = kind === "project" ? source.pendingProjectCreationResourceId : source.pendingTaskCreationResourceId;
  const reconciliationToken = kind === "project"
    ? (resourceId ? source.getProjectReconciliationToken?.(resourceId) : undefined)
    : (resourceId ? source.getTaskReconciliationToken?.(resourceId) : undefined);
  const canConfirm = kind === "project"
    ? Boolean(resourceId && source.isProjectReconciliationReady?.(resourceId, reconciliationToken))
    : Boolean(resourceId && source.isTaskReconciliationReady?.(resourceId, reconciliationToken));

  useEffect(() => {
    const listener = () => setRevision((value) => value + 1);
    state.listeners?.add(listener);
    return () => {
      state.listeners?.delete(listener);
    };
  }, [state]);
  const runCreate = async () => {
    const result = kind === "project"
      ? await source.createProject({ name: "Stale project", summary: "generation boundary" })
      : await source.createTask({ title: "Stale task", goal: "generation boundary", projectId });
    state.lastResult = result.ok ? result.warning ?? "unexpected-success" : result.message;
    notifyScenario(state);
  };
  const revalidateSamePrincipal = () => {
    state.sessionGeneration += 1;
    notifyScenario(state);
  };
  const resolveCreate = () => {
    if (kind === "project") state.resolveProjectCreate?.();
    else state.resolveTaskCreate?.();
  };
  const refreshCurrentGeneration = async () => {
    try {
      await source.refresh();
      state.lastResult = "current-refresh-complete";
    } catch (error) {
      state.lastResult = error instanceof Error ? error.message : "refresh-failed";
    }
    notifyScenario(state);
  };
  const acknowledge = () => {
    if (!resourceId) return;
    const acknowledged = kind === "project"
      ? source.acknowledgeProjectReconciliation?.(resourceId, reconciliationToken)
      : source.acknowledgeTaskReconciliation?.(resourceId, reconciliationToken);
    state.lastResult = acknowledged ? "acknowledged" : "acknowledge-blocked";
    notifyScenario(state);
  };

  return (
    <div className="min-h-screen bg-[var(--canvas)] p-8" data-visual-evidence-surface>
      <div className="mx-auto grid max-w-3xl gap-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-6" data-visual-evidence-target>
        <h1 className="text-lg font-semibold">Stale generation {kind} creation</h1>
        <p data-testid="stale-generation-value">认证代次：{state.sessionGeneration}</p>
        <p data-testid="stale-generation-status">状态：{source.status}</p>
        <p data-testid="stale-generation-project-calls">项目 POST：{state.createCalls}</p>
        <p data-testid="stale-generation-task-calls">任务 POST：{state.createTaskCalls}</p>
        <p data-testid="stale-generation-resource">确切 ID：{resourceId ?? "无"}</p>
        <p data-testid="stale-generation-result">结果：{state.lastResult || "无"}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <button type="button" className="button button-secondary" onClick={() => { void runCreate(); }}>尝试创建{kind === "project" ? "项目" : "任务"}</button>
          <button type="button" className="button button-secondary" onClick={revalidateSamePrincipal}>同身份重新认证</button>
          <button type="button" className="button button-secondary" onClick={resolveCreate}>完成旧代创建回调</button>
          <button type="button" className="button button-secondary" onClick={() => { void refreshCurrentGeneration(); }}>当前代刷新并核对</button>
          {canConfirm && <button type="button" className="button button-secondary" onClick={acknowledge}>确认当前状态并解除阻塞</button>}
        </div>
      </div>
    </div>
  );
}

function RecoveryContent({ state }: { state: ScenarioState }) {
  const source = usePublishedProjectTaskSource({
    client: useMemo(() => createClient(state), [state]),
    enabled: true,
    canCreateProjects: true,
    principalId: state.principalId
  });
  const [, setRevision] = useState(0);

  useEffect(() => {
    state.notify = () => setRevision((value) => value + 1);
    return () => {
      state.notify = undefined;
      restoreScenario(state);
    };
  }, [state]);

  const triggerRemoteRemoval = () => {
    const key = mutationNoticeKey(noticeId);
    const oldValue = JSON.stringify(remoteNotice);
    state.refreshRequested = true;
    window.localStorage.removeItem(key);
    window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue: null, storageArea: window.localStorage, url: window.location.href }));
  };

  const runCreate = async () => {
    const result = await source.createProject({ name: "Blocked project", summary: "" });
    state.lastResult = result.ok ? "unexpected-success" : result.message;
    notifyScenario(state);
  };

  const runUpdate = async () => {
    const result = await source.updateTask(taskId, { title: "Updated task" });
    state.lastResult = result.ok ? "updated" : result.message;
    notifyScenario(state);
  };

  const runTaskCreate = async () => {
    const result = await source.createTask({
      title: "Mismatch task",
      goal: "Verify response identity",
      projectId,
      parentIds: [parentTaskId],
      dependsOn: [parentTaskId]
    });
    state.lastResult = result.ok ? "unexpected-success" : result.message;
    notifyScenario(state);
  };

  return (
    <div className="min-h-screen bg-[var(--canvas)] p-8" data-visual-evidence-surface>
      <div className="mx-auto grid max-w-2xl gap-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-6" data-visual-evidence-target>
        <h1 className="text-lg font-semibold">Production source recovery</h1>
        <p data-testid="source-status">状态：{source.status}</p>
        <p data-testid="refresh-state">刷新：{state.refreshState}</p>
        <p data-testid="create-calls">项目 POST：{state.createCalls}</p>
        <p data-testid="task-create-calls">任务 POST：{state.createTaskCalls}</p>
        <p data-testid="requested-task-id">请求任务 ID：{state.requestedTaskId || "无"}</p>
        <p data-testid="update-calls">任务 PATCH：{state.updateCalls}</p>
        <p data-testid="relation-calls">关系 POST：{state.relationCalls}</p>
        <p data-testid="dependency-calls">依赖 POST：{state.dependencyCalls}</p>
        <p data-testid="last-result">结果：{state.lastResult || "无"}</p>
        {state.scenario === "persistence-failure" ? <button type="button" onClick={() => { void runCreate(); }} disabled={source.status !== "ready"}>尝试创建项目</button> : state.scenario === "identity-mismatch" ? <button type="button" onClick={() => { void runTaskCreate(); }} disabled={source.status !== "ready"}>尝试创建任务</button> : <><button type="button" onClick={triggerRemoteRemoval}>移除远端通知</button><button type="button" onClick={() => { void runUpdate(); }}>尝试更新任务</button>{state.scenario === "remote-refresh" && <button type="button" onClick={() => state.resolveRefresh?.()}>完成刷新</button>}</>}
      </div>
    </div>
  );
}

function renderScenario(scenario: Scenario) {
  const state: ScenarioState = { scenario, principalId, sessionGeneration: 1, projectListCalls: 0, createCalls: 0, createTaskCalls: 0, updateCalls: 0, relationCalls: 0, dependencyCalls: 0, requestedTaskId: "", refreshRequested: false, refreshState: "idle", lastResult: "", broadcastPatched: false, locksPatched: false, setItemPatched: false };
  prepareScenario(state);
  return <RecoveryHarness state={state} />;
}

export const PersistenceFailureDoesNotPost: Story = {
  render: () => renderScenario("persistence-failure"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "尝试创建项目" }));
    expect(await canvas.findByTestId("last-result")).toHaveTextContent("写入没有执行");
    expect(canvas.getByTestId("create-calls")).toHaveTextContent("项目 POST：0");
  }
};
export const RemoteRemovalWaitsForCompleteRefresh: Story = {
  render: () => renderScenario("remote-refresh"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "移除远端通知" }));
    expect(await canvas.findByTestId("refresh-state")).toHaveTextContent("刷新：pending");
    await userEvent.click(canvas.getByRole("button", { name: "尝试更新任务" }));
    expect(await canvas.findByTestId("last-result")).toHaveTextContent("待确认");
    expect(canvas.getByTestId("update-calls")).toHaveTextContent("任务 PATCH：0");
    await userEvent.click(canvas.getByRole("button", { name: "完成刷新" }));
    expect(await canvas.findByTestId("refresh-state")).toHaveTextContent("刷新：complete");
    await userEvent.click(canvas.getByRole("button", { name: "尝试更新任务" }));
    expect(await canvas.findByTestId("last-result")).toHaveTextContent("结果：updated");
    expect(canvas.getByTestId("update-calls")).toHaveTextContent("任务 PATCH：1");
  }
};

export const RemoteRemovalFailureKeepsWriteBlocked: Story = {
  render: () => renderScenario("remote-refresh-failure"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "移除远端通知" }));
    expect(await canvas.findByTestId("refresh-state")).toHaveTextContent("刷新：failed");
    await userEvent.click(canvas.getByRole("button", { name: "尝试更新任务" }));
    expect(await canvas.findByTestId("last-result")).toHaveTextContent("待确认");
    expect(canvas.getByTestId("update-calls")).toHaveTextContent("任务 PATCH：0");
  }
};

export const RemoteRemovalFailureSurvivesSourceRemount: Story = {
  render: () => <SharedRefreshHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByTestId("主实例-status")).toHaveTextContent("状态：ready"));
    await waitFor(() => expect(canvas.getByTestId("副本实例-status")).toHaveTextContent("状态：ready"));
    await userEvent.click(await canvas.findByRole("button", { name: "主实例移除远端通知" }));
    await waitFor(() => expect(canvas.getByTestId("shared-refresh-state")).toHaveTextContent("刷新：failed"));
    await userEvent.click(canvas.getByRole("button", { name: "重挂载副本实例" }));
    await userEvent.click(canvas.getByRole("button", { name: "副本实例尝试更新任务" }));
    await waitFor(() => expect(canvas.getByTestId("副本实例-result")).toHaveTextContent("待确认"));
    expect(canvas.getByTestId("shared-update-calls")).toHaveTextContent("任务 PATCH：0");
  }
};

export const SamePrincipalGenerationKeepsRefreshBarrier: Story = {
  render: () => <GenerationRefreshHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByTestId("generation-value")).toHaveTextContent("认证代次：1"));
    await userEvent.click(await canvas.findByRole("button", { name: "移除远端通知" }));
    await waitFor(() => expect(canvas.getByTestId("generation-refresh-state")).toHaveTextContent("刷新：pending"));
    await userEvent.click(canvas.getByRole("button", { name: "同身份重新认证" }));
    await waitFor(() => expect(canvas.getByTestId("generation-value")).toHaveTextContent("认证代次：2"));
    await userEvent.click(canvas.getByRole("button", { name: "完成旧代刷新" }));
    await userEvent.click(canvas.getByRole("button", { name: "尝试更新任务" }));
    await waitFor(() => expect(canvas.getByTestId("generation-result")).toHaveTextContent("待确认"));
    expect(canvas.getByTestId("generation-update-calls")).toHaveTextContent("任务 PATCH：0");
    await userEvent.click(canvas.getByRole("button", { name: "当前代刷新并核对" }));
    await waitFor(() => expect(canvas.getByTestId("generation-result")).toHaveTextContent("current-refresh-complete"));
    await userEvent.click(canvas.getByRole("button", { name: "尝试更新任务" }));
    await waitFor(() => expect(canvas.getByTestId("generation-result")).toHaveTextContent("结果：updated"));
    expect(canvas.getByTestId("generation-update-calls")).toHaveTextContent("任务 PATCH：1");
  }
};

export const StaleProjectCreateKeepsExactIdBarrierWithoutBroadcastChannel: Story = {
  render: () => <StaleGenerationCreateHarness kind="project" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByTestId("stale-generation-status")).toHaveTextContent("状态：ready"));
    await userEvent.click(canvas.getByRole("button", { name: "尝试创建项目" }));
    await userEvent.click(canvas.getByRole("button", { name: "同身份重新认证" }));
    await userEvent.click(canvas.getByRole("button", { name: "完成旧代创建回调" }));
    await waitFor(() => expect(canvas.getByTestId("stale-generation-result")).toHaveTextContent("登录身份已变化"));
    expect(canvas.getByTestId("stale-generation-resource")).toHaveTextContent(/^确切 ID：project_[0-9a-f]{32}$/);
    await userEvent.click(canvas.getByRole("button", { name: "尝试创建项目" }));
    expect(canvas.getByTestId("stale-generation-project-calls")).toHaveTextContent("项目 POST：1");
    await userEvent.click(canvas.getByRole("button", { name: "当前代刷新并核对" }));
    await waitFor(() => expect(canvas.getByTestId("stale-generation-result")).toHaveTextContent("current-refresh-complete"));
    await userEvent.click(canvas.getByRole("button", { name: "确认当前状态并解除阻塞" }));
    expect(canvas.getByTestId("stale-generation-result")).toHaveTextContent("acknowledged");
  }
};

export const StaleTaskCreateKeepsExactIdBarrierWithoutBroadcastChannel: Story = {
  render: () => <StaleGenerationCreateHarness kind="task" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByTestId("stale-generation-status")).toHaveTextContent("状态：ready"));
    await userEvent.click(canvas.getByRole("button", { name: "尝试创建任务" }));
    await userEvent.click(canvas.getByRole("button", { name: "同身份重新认证" }));
    await userEvent.click(canvas.getByRole("button", { name: "完成旧代创建回调" }));
    await waitFor(() => expect(canvas.getByTestId("stale-generation-result")).toHaveTextContent("登录身份已变化"));
    expect(canvas.getByTestId("stale-generation-resource")).toHaveTextContent(/^确切 ID：task_[0-9a-f]{32}$/);
    await userEvent.click(canvas.getByRole("button", { name: "尝试创建任务" }));
    expect(canvas.getByTestId("stale-generation-task-calls")).toHaveTextContent("任务 POST：1");
    await userEvent.click(canvas.getByRole("button", { name: "当前代刷新并核对" }));
    await waitFor(() => expect(canvas.getByTestId("stale-generation-result")).toHaveTextContent("current-refresh-complete"));
    await userEvent.click(canvas.getByRole("button", { name: "确认当前状态并解除阻塞" }));
    expect(canvas.getByTestId("stale-generation-result")).toHaveTextContent("acknowledged");
  }
};

export const IdentityMismatchDoesNotRetryOrReplayRelations: Story = {
  render: () => renderScenario("identity-mismatch"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/状态：\s*ready/);
    const createButton = await canvas.findByRole("button", { name: "尝试创建任务" });
    await waitFor(() => expect(createButton).toBeEnabled());
    await userEvent.click(createButton);
    expect(await canvas.findByText("服务端未返回预选任务身份，写入结果待确认；请刷新后核对。", { exact: false })).toBeInTheDocument();
    expect(canvas.getByTestId("task-create-calls")).toHaveTextContent("任务 POST：1");
    expect(canvas.getByTestId("requested-task-id")).toHaveTextContent(/^请求任务 ID：task_[0-9a-f]{32}$/);
    expect(canvas.getByTestId("relation-calls")).toHaveTextContent("关系 POST：0");
    expect(canvas.getByTestId("dependency-calls")).toHaveTextContent("依赖 POST：0");

    await userEvent.click(createButton);
    expect(canvas.getByTestId("task-create-calls")).toHaveTextContent("任务 POST：1");
    expect(canvas.getByTestId("relation-calls")).toHaveTextContent("关系 POST：0");
    expect(canvas.getByTestId("dependency-calls")).toHaveTextContent("依赖 POST：0");
  }
};
