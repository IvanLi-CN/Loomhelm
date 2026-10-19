import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";

import { createFixturesForState } from "./fixtures";
import { demoStorageKey } from "./bootstrap";
import type {
  DemoBootstrapSnapshot,
  DemoDataMode,
  DemoFixtures,
  DemoMutation,
  DemoNetwork,
  DemoPersona,
  DemoScene,
  DemoTask,
  TaskState,
  TaskView,
  ThemeMode
} from "./types";

export type InspectorMode = "collapsed" | "floating" | "sidebar";
type ExpandedInspectorMode = Exclude<InspectorMode, "collapsed">;

export interface InspectorPosition {
  left: number;
  top: number;
}

interface DemoContextValue extends DemoBootstrapSnapshot {
  fixtures: DemoFixtures;
  mutations: DemoMutation[];
  notice: string | null;
  inspectorMode: InspectorMode;
  inspectorOpen: boolean;
  inspectorPosition: InspectorPosition | null;
  canWrite: boolean;
  isReadOnly: boolean;
  setScene: (scene: DemoScene) => void;
  setPersona: (persona: DemoPersona) => void;
  setNetwork: (network: DemoNetwork) => void;
  setDataMode: (dataMode: DemoDataMode) => void;
  setTheme: (theme: ThemeMode) => void;
  setTaskView: (scope: string, view: TaskView) => void;
  setDraft: (conversationId: string, value: string) => void;
  sendMessage: (conversationId: string) => void;
  decideAttention: (attentionId: string, decision: "approve" | "deny") => void;
  setTaskState: (taskId: string, state: TaskState) => void;
  createTask: (input: { title: string; goal: string; projectId: string }) => string | null;
  createConversation: (input: { message: string; projectId?: string }) => string | null;
  recover: () => void;
  reset: () => void;
  setInspectorMode: (mode: InspectorMode) => void;
  setInspectorOpen: (open: boolean) => void;
  setInspectorPosition: (position: InspectorPosition | null) => void;
  shareUrl: () => string;
  dismissNotice: () => void;
}

const DemoContext = createContext<DemoContextValue | null>(null);

function nowLabel(): string {
  return "刚刚";
}

function isWideViewport(): boolean {
  return typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 1200px)").matches;
}

function writeStorage(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(demoStorageKey(key), JSON.stringify(value));
  } catch {
    // The demo remains usable when storage is disabled; state is memory-only.
  }
}

function updateDemoQuery(values: Record<string, string | null>): void {
  const url = new URL(window.location.href);
  Object.entries(values).forEach(([key, value]) => {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  });
  window.history.replaceState(window.history.state, "", url);
}

export function DemoProvider({ runtime, children }: PropsWithChildren<{ runtime: DemoBootstrapSnapshot }>) {
  const [scene, setSceneState] = useState(runtime.scene);
  const [persona, setPersonaState] = useState(runtime.persona);
  const [network, setNetworkState] = useState(runtime.network);
  const [dataMode, setDataModeState] = useState(runtime.dataMode);
  const [theme, setThemeState] = useState(runtime.theme);
  const [taskViews, setTaskViews] = useState(runtime.taskViews);
  const [drafts, setDrafts] = useState(runtime.drafts);
  const [fixtures, setFixtures] = useState(runtime.fixtures);
  const [mutations, setMutations] = useState<DemoMutation[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [inspectorMode, setInspectorModeState] = useState<InspectorMode>(() => isWideViewport() ? "sidebar" : "collapsed");
  const [expandedInspectorMode, setExpandedInspectorMode] = useState<ExpandedInspectorMode>(() => isWideViewport() ? "sidebar" : "floating");
  const [inspectorPosition, setInspectorPositionState] = useState<InspectorPosition | null>(null);
  const inspectorOpen = inspectorMode !== "collapsed";

  const isReadOnly = persona === "viewer" || scene === "readonly" || scene === "approval-expired";
  const canWrite = network === "online" && persona !== "viewer" && scene !== "readonly" && scene !== "error" && scene !== "loading";

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
    root.dataset.demo = "true";
  }, [theme]);

  useEffect(() => {
    const viewport = window.matchMedia("(min-width: 1200px)");
    const collapseSidebar = () => {
      if (!viewport.matches && inspectorMode === "sidebar") setInspectorModeState("collapsed");
    };
    viewport.addEventListener("change", collapseSidebar);
    return () => viewport.removeEventListener("change", collapseSidebar);
  }, [inspectorMode]);

  const setInspectorMode = (nextMode: InspectorMode) => {
    if (nextMode === "collapsed") {
      setInspectorModeState("collapsed");
      return;
    }

    setExpandedInspectorMode(nextMode);
    setInspectorModeState(nextMode === "sidebar" && !isWideViewport() ? "collapsed" : nextMode);
  };

  const setInspectorOpen = (open: boolean) => {
    if (!open) {
      setInspectorModeState("collapsed");
      return;
    }

    setInspectorModeState(expandedInspectorMode === "sidebar" && isWideViewport() ? "sidebar" : "floating");
  };

  const setInspectorPosition = (position: InspectorPosition | null) => {
    setInspectorPositionState(position);
  };

  const record = (label: string, detail: string) => {
    setMutations((current) => [
      { id: `${Date.now()}-${current.length}`, label, detail, at: nowLabel() },
      ...current
    ].slice(0, 5));
    setNotice(`模拟操作：${label}。${detail}`);
  };

  const refreshFixtures = (nextPersona: DemoPersona, nextDataMode: DemoDataMode, nextScene: DemoScene) => {
    setFixtures(createFixturesForState(nextPersona, nextDataMode, nextScene === "permission-changed"));
  };

  const setScene = (next: DemoScene) => {
    setSceneState(next);
    updateDemoQuery({ demo: next });
    refreshFixtures(persona, dataMode, next);
    if (next === "offline") setNetworkState("offline");
    if (next === "normal" && network === "offline") setNetworkState("online");
    setNotice(`已切换到「${next}」演示场景，页面状态仍为 mock-only。`);
  };

  const setPersona = (next: DemoPersona) => {
    setPersonaState(next);
    updateDemoQuery({ d_persona: next });
    refreshFixtures(next, dataMode, scene);
    setNotice(`已切换演示身份：${next === "owner" ? "工作区主人" : next === "reviewer" ? "项目审阅者" : "只读访客"}。`);
  };

  const setNetwork = (next: DemoNetwork) => {
    setNetworkState(next);
    updateDemoQuery({ d_network: next });
    setNotice(next === "online" ? "模拟连接已恢复，不会自动发送草稿或重放命令。" : next === "recovering" ? "模拟连接正在恢复，控制入口保持保护。" : "已进入模拟离线状态，发送和控制入口已禁用。");
  };

  const setDataMode = (next: DemoDataMode) => {
    setDataModeState(next);
    updateDemoQuery({ d_data: next });
    refreshFixtures(persona, next, scene);
    setNotice(`已切换数据夹具：${next === "full" ? "完整" : next === "sparse" ? "精简" : "空状态"}。`);
  };

  const setTheme = (next: ThemeMode) => {
    setThemeState(next);
    writeStorage("theme", next);
    updateDemoQuery({ d_theme: next });
  };

  const setTaskView = (scope: string, view: TaskView) => {
    setTaskViews((current) => {
      const next = { ...current, [scope]: view };
      writeStorage("task-views", next);
      return next;
    });
  };

  const setDraft = (conversationId: string, value: string) => {
    setDrafts((current) => {
      const next = { ...current, [conversationId]: value };
      writeStorage("drafts", next);
      return next;
    });
  };

  const sendMessage = (conversationId: string) => {
    if (!canWrite) {
      setNotice("当前演示状态不可发送；草稿仍保留在当前 Demo 存储范围内。\n");
      return;
    }
    const text = drafts[conversationId]?.trim();
    if (!text) return;
    setFixtures((current) => ({
      ...current,
      conversations: current.conversations.map((conversation) => conversation.id === conversationId
        ? {
            ...conversation,
            preview: text,
            updated: nowLabel(),
            history: [
              ...conversation.history,
              { id: `${conversationId}-${Date.now()}`, role: "user", label: "你", text }
            ]
          }
        : conversation)
    }));
    setDraft(conversationId, "");
    record("发送消息", "只更新内存中的模拟对话，没有连接 Codex 或真实服务。");
  };

  const decideAttention = (attentionId: string, decision: "approve" | "deny") => {
    const item = fixtures.attention.find((entry) => entry.id === attentionId);
    if (!item || item.status !== "pending" || !canWrite || scene === "approval-expired") {
      setNotice("当前请求已过期、只读或连接不可用，不能继续模拟控制。");
      return;
    }
    setFixtures((current) => ({
      ...current,
      attention: current.attention.map((entry) => entry.id === attentionId ? { ...entry, status: "resolved", decision } : entry),
      tasks: current.tasks.map((task) => task.id === item.taskId ? { ...task, execution: decision === "approve" ? "执行中" : "已拒绝" } : task),
      conversations: current.conversations.map((conversation) => conversation.id === item.conversationId ? { ...conversation, execution: decision === "approve" ? "执行中" : "已拒绝" } : conversation)
    }));
    record(decision === "approve" ? "批准请求" : "拒绝请求", "任务业务状态保持独立，结果仅存在于内存中的演示夹具。");
  };

  const setTaskState = (taskId: string, nextState: TaskState) => {
    if (!canWrite) {
      setNotice("当前演示身份或网络状态为只读，任务状态没有改变。");
      return;
    }
    setFixtures((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === taskId ? { ...task, state: nextState, updated: nowLabel() } : task)
    }));
    record("更新任务状态", `已将 ${taskId} 标记为「${nextState}」，不会写入服务端。`);
  };

  const createTask = (input: { title: string; goal: string; projectId: string }) => {
    if (!canWrite) {
      setNotice("当前 Demo 状态不允许创建任务；这是安全的只读入口。");
      return null;
    }
    const id = `DEMO-${fixtures.tasks.length + 1}`;
    const task: DemoTask = {
      id,
      title: input.title,
      goal: input.goal,
      projectId: input.projectId,
      state: "待办",
      execution: "未开始",
      dependsOn: [],
      updated: nowLabel()
    };
    setFixtures((current) => ({ ...current, tasks: [task, ...current.tasks] }));
    record("创建模拟任务", `${id} 只存在于当前页面内，刷新或重置 Demo 后恢复种子数据。`);
    return id;
  };

  const createConversation = (input: { message: string; projectId?: string }) => {
    if (!canWrite) {
      setNotice("当前 Demo 状态不允许创建对话；这是安全的只读入口。");
      return null;
    }
    const id = `C-DEMO-${fixtures.conversations.length + 1}`;
    setFixtures((current) => ({
      ...current,
      conversations: [
        {
          id,
          title: input.message.trim().slice(0, 32),
          projectId: input.projectId,
          execution: "已连接",
          preview: input.message.trim(),
          updated: nowLabel(),
          history: [{ id: `${id}-1`, role: "user", label: "你", text: input.message.trim() }]
        },
        ...current.conversations
      ]
    }));
    record("创建模拟对话", `${id} 只存在于当前页面内，没有创建真实 Codex thread。`);
    return id;
  };

  const recover = () => {
    setSceneState("normal");
    setNetworkState("online");
    updateDemoQuery({ demo: "normal", d_network: "online" });
    refreshFixtures(persona, dataMode, "normal");
    setNotice("模拟工作区已恢复；草稿和未确认操作不会自动提交。");
  };

  const reset = () => {
    setSceneState("normal");
    setPersonaState("owner");
    setNetworkState("online");
    setDataModeState("full");
    setTaskViews({});
    setDrafts({});
    setMutations([]);
    setFixtures(createFixturesForState("owner", "full", false));
    updateDemoQuery({ demo: "normal", d_persona: "owner", d_network: "online", d_data: "full" });
    setNotice("Demo 已重置为确定性的完整种子数据；没有触发真实服务。");
  };

  const shareUrl = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("demo", scene);
    url.searchParams.set("d_persona", persona);
    url.searchParams.set("d_network", network);
    url.searchParams.set("d_data", dataMode);
    if (theme !== "system") url.searchParams.set("d_theme", theme);
    return url.toString();
  };

  const value = useMemo<DemoContextValue>(() => ({
    scene,
    persona,
    network,
    dataMode,
    theme,
    taskViews,
    drafts,
    fixtures,
    mutations,
    notice,
    inspectorMode,
    inspectorOpen,
    inspectorPosition,
    canWrite,
    isReadOnly,
    setScene,
    setPersona,
    setNetwork,
    setDataMode,
    setTheme,
    setTaskView,
    setDraft,
    sendMessage,
    decideAttention,
    setTaskState,
    createTask,
    createConversation,
    recover,
    reset,
    setInspectorMode,
    setInspectorOpen,
    setInspectorPosition,
    shareUrl,
    dismissNotice: () => setNotice(null)
  }), [
    scene,
    persona,
    network,
    dataMode,
    theme,
    taskViews,
    drafts,
    fixtures,
    mutations,
    notice,
    inspectorMode,
    inspectorOpen,
    inspectorPosition,
    expandedInspectorMode,
    canWrite,
    isReadOnly
  ]);

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemoRuntime(): DemoContextValue {
  const context = useContext(DemoContext);
  if (!context) throw new Error("Demo runtime is not available outside the demo bootstrap.");
  return context;
}

export function useOptionalDemoRuntime(): DemoContextValue | null {
  return useContext(DemoContext);
}

export function getProject(fixtures: DemoFixtures, id: string | undefined) {
  return fixtures.projects.find((project) => project.id === id);
}

export function getTask(fixtures: DemoFixtures, id: string | undefined) {
  return fixtures.tasks.find((task) => task.id === id);
}

export function getConversation(fixtures: DemoFixtures, id: string | undefined) {
  return fixtures.conversations.find((conversation) => conversation.id === id);
}
