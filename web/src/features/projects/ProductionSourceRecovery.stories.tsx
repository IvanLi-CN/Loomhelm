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
type Scenario = "persistence-failure" | "remote-refresh" | "remote-refresh-failure" | "identity-mismatch";

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
  projectListCalls: number;
  createCalls: number;
  createTaskCalls: number;
  updateCalls: number;
  relationCalls: number;
  dependencyCalls: number;
  requestedTaskId: string;
  refreshState: "idle" | "pending" | "failed" | "complete";
  lastResult: string;
  notify?: () => void;
  resolveRefresh?: () => void;
  broadcastDescriptor?: PropertyDescriptor;
  locksDescriptor?: PropertyDescriptor;
  setItemDescriptor?: PropertyDescriptor;
  broadcastPatched: boolean;
  locksPatched: boolean;
  setItemPatched: boolean;
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
  if (state.scenario === "remote-refresh" || state.scenario === "remote-refresh-failure") {
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
      if (state.projectListCalls > 1) {
        state.refreshState = "pending";
        state.notify?.();
        if (state.scenario === "remote-refresh-failure") {
          state.refreshState = "failed";
          state.notify?.();
          throw new Error("刷新项目失败");
        }
        return new Promise((resolve) => {
          state.resolveRefresh = () => {
            state.resolveRefresh = undefined;
            resolve({ items: [project], has_more: false });
          };
        });
      }
      return { items: [project], has_more: false };
    },
    listProjectMembers: async () => ({ items: [member], has_more: false }),
    listTasks: async () => {
      if (state.refreshState === "pending") {
        state.refreshState = "complete";
        state.notify?.();
      }
      return { items: [task, parentTask], has_more: false };
    },
    getTaskRelationships: async () => emptyRelationships,
    createProject: async () => {
      state.createCalls += 1;
      state.notify?.();
      return { project };
    },
    updateTask: async ({ body }: { body: { title?: string } }) => {
      state.updateCalls += 1;
      state.notify?.();
      return { task: { ...task, title: body.title ?? task.title } };
    },
    getProject: async () => ({ project }),
    updateProject: async () => ({ project }),
    deleteProject: async () => undefined,
    createTask: async ({ body }: { body: { id?: string } }) => {
      state.createTaskCalls += 1;
      state.requestedTaskId = body.id ?? "";
      state.notify?.();
      if (state.scenario === "identity-mismatch") {
        return { task: { ...task, id: "task_fedcfedcfedcfedcfedcfedcfedcfedc" } };
      }
      return { task };
    },
    getTask: async () => ({ task }),
    deleteTask: async () => undefined,
    addTaskParent: async () => {
      state.relationCalls += 1;
      state.notify?.();
    },
    removeTaskParent: async () => undefined,
    addTaskDependency: async () => {
      state.dependencyCalls += 1;
      state.notify?.();
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
    window.localStorage.removeItem(key);
    window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue: null, storageArea: window.localStorage, url: window.location.href }));
  };

  const runCreate = async () => {
    const result = await source.createProject({ name: "Blocked project", summary: "" });
    state.lastResult = result.ok ? "unexpected-success" : result.message;
    state.notify?.();
  };

  const runUpdate = async () => {
    const result = await source.updateTask(taskId, { title: "Updated task" });
    state.lastResult = result.ok ? "updated" : result.message;
    state.notify?.();
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
    state.notify?.();
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
  const state: ScenarioState = { scenario, principalId, projectListCalls: 0, createCalls: 0, createTaskCalls: 0, updateCalls: 0, relationCalls: 0, dependencyCalls: 0, requestedTaskId: "", refreshState: "idle", lastResult: "", broadcastPatched: false, locksPatched: false, setItemPatched: false };
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
