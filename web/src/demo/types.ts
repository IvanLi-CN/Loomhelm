export const taskStates = ["待办", "进行中", "阻塞", "完成", "取消"] as const;
export type TaskState = (typeof taskStates)[number];

export const executionStates = [
  "未开始",
  "执行中",
  "等待审批",
  "待输入",
  "待核对",
  "已结束",
  "已拒绝",
  "已连接",
  "结果不确定"
] as const;
export type ExecutionState = (typeof executionStates)[number];

export const demoScenes = [
  "normal",
  "loading",
  "empty",
  "error",
  "offline",
  "approval-expired",
  "readonly",
  "unknown",
  "permission-changed",
  "update-available"
] as const;
export type DemoScene = (typeof demoScenes)[number];

export const demoPersonas = ["owner", "operator", "viewer"] as const;
export type DemoPersona = (typeof demoPersonas)[number];

export const demoNetworks = ["online", "recovering", "offline"] as const;
export type DemoNetwork = (typeof demoNetworks)[number];

export const demoDataModes = ["full", "empty", "sparse"] as const;
export type DemoDataMode = (typeof demoDataModes)[number];

export const taskViews = ["list", "board", "graph"] as const;
export type TaskView = (typeof taskViews)[number];

export const themeModes = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof themeModes)[number];

export interface DemoProject {
  id: string;
  name: string;
  summary: string;
  accent: string;
}

export interface DemoTask {
  id: string;
  title: string;
  goal: string;
  projectId: string;
  state: TaskState;
  execution: ExecutionState;
  conversationId?: string;
  parentId?: string;
  dependsOn: string[];
  updated: string;
}

export interface DemoMessage {
  id: string;
  role: "assistant" | "user" | "system";
  label: string;
  text: string;
  detail?: string;
}

export interface DemoConversation {
  id: string;
  title: string;
  projectId?: string;
  taskId?: string;
  execution: ExecutionState;
  preview: string;
  updated: string;
  history: DemoMessage[];
}

export type AttentionKind = "审批" | "需要输入" | "结果待核对";

export interface DemoAttention {
  id: string;
  kind: AttentionKind;
  title: string;
  summary: string;
  taskId: string;
  conversationId: string;
  command?: string;
  directory?: string;
  impact?: string;
  status: "pending" | "expired" | "resolved";
  decision?: "approve" | "deny";
}

export interface DemoFixtures {
  projects: DemoProject[];
  tasks: DemoTask[];
  conversations: DemoConversation[];
  attention: DemoAttention[];
}

export interface DemoMutation {
  id: string;
  label: string;
  detail: string;
  at: string;
}

export interface DemoBootstrapSnapshot {
  scene: DemoScene;
  persona: DemoPersona;
  network: DemoNetwork;
  dataMode: DemoDataMode;
  theme: ThemeMode;
  taskViews: Record<string, TaskView>;
  drafts: Record<string, string>;
  fixtures: DemoFixtures;
}

export interface DemoQueryState {
  scene?: DemoScene;
  persona?: DemoPersona;
  network?: DemoNetwork;
  dataMode?: DemoDataMode;
  theme?: ThemeMode;
}
