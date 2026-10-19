import type {
  DemoDataMode,
  DemoFixtures,
  DemoPersona,
  DemoProject,
  DemoTask
} from "./types";

const projects: DemoProject[] = [
  {
    id: "loomhelm",
    name: "Loomhelm",
    summary: "产品工作台与远程 Codex 协作",
    accent: "blue"
  },
  {
    id: "sidecar",
    name: "Sidecar Notes",
    summary: "研究记录与可复用结论",
    accent: "violet"
  },
  {
    id: "device-lab",
    name: "Device Lab",
    summary: "设备工作流和实验验证",
    accent: "teal"
  }
];

const tasks: DemoTask[] = [
  {
    id: "LH-30",
    title: "整理远程工作区边界",
    goal: "把工作台、任务和对话的访问边界整理成可验证的使用路径。",
    projectId: "loomhelm",
    state: "进行中",
    execution: "等待审批",
    conversationId: "C-101",
    dependsOn: [],
    updated: "8 分钟前"
  },
  {
    id: "LH-35",
    title: "核对蓝绿发布回滚说明",
    goal: "确认候选版本、健康检查和不确定结果的人工对账入口。",
    projectId: "loomhelm",
    state: "完成",
    execution: "待核对",
    conversationId: "C-103",
    dependsOn: [],
    updated: "今天 09:42"
  },
  {
    id: "LH-42",
    title: "确认移动端草稿恢复",
    goal: "验证手机端切换任务信息后仍保留对话草稿和阅读位置。",
    projectId: "loomhelm",
    state: "待办",
    execution: "未开始",
    conversationId: "C-102",
    dependsOn: ["LH-30"],
    updated: "昨天"
  },
  {
    id: "SN-12",
    title: "收集项目文档索引",
    goal: "把已有说明按项目上下文归档，供后续任务引用。",
    projectId: "sidecar",
    state: "阻塞",
    execution: "待输入",
    conversationId: "C-104",
    dependsOn: [],
    updated: "昨天"
  },
  {
    id: "SN-18",
    title: "整理研究结论",
    goal: "把研究过程中的结论和未决问题留在同一段对话上下文。",
    projectId: "sidecar",
    state: "完成",
    execution: "已结束",
    conversationId: "C-105",
    dependsOn: ["SN-12"],
    updated: "周一"
  },
  {
    id: "DL-08",
    title: "验证设备工作流",
    goal: "检查设备任务如何引用外部父任务与跨项目前置依赖。",
    projectId: "device-lab",
    state: "进行中",
    execution: "执行中",
    conversationId: "C-106",
    parentId: "LH-30",
    dependsOn: ["SN-12"],
    updated: "12 分钟前"
  },
  {
    id: "DL-11",
    title: "同步实验记录",
    goal: "把实验记录和任务结果放回关联对话，避免产生独立产物入口。",
    projectId: "device-lab",
    state: "待办",
    execution: "未开始",
    conversationId: "C-107",
    parentId: "DL-08",
    dependsOn: [],
    updated: "今天 08:16"
  },
  {
    id: "LH-48",
    title: "收敛更新后的上下文",
    goal: "确认更新提示不会发送草稿，也不会接管另一台设备。",
    projectId: "loomhelm",
    state: "待办",
    execution: "未开始",
    dependsOn: [],
    updated: "上周"
  }
];

const conversations = [
  {
    id: "C-101",
    title: "审批远程工作区变更",
    projectId: "loomhelm",
    taskId: "LH-30",
    execution: "等待审批" as const,
    preview: "需要确认远程工作区的读取与写入边界。",
    updated: "8 分钟前",
    history: [
      {
        id: "C-101-1",
        role: "assistant" as const,
        label: "Codex · 主对话",
        text: "我先整理当前工作区的上下文，再请求一次明确审批。",
        detail: "已读取任务上下文与最近一次执行记录。"
      },
      {
        id: "C-101-2",
        role: "assistant" as const,
        label: "审批请求",
        text: "请求读取 /workspace/loomhelm，并允许写入生成的校验报告。"
      }
    ]
  },
  {
    id: "C-102",
    title: "确认移动端草稿恢复",
    projectId: "loomhelm",
    taskId: "LH-42",
    execution: "未开始" as const,
    preview: "草稿已保留，等待继续这项验证。",
    updated: "昨天",
    history: [
      {
        id: "C-102-1",
        role: "assistant" as const,
        label: "Codex · 主对话",
        text: "手机端切换到任务信息后，仍应回到同一段对话和草稿。"
      }
    ]
  },
  {
    id: "C-103",
    title: "核对发布后的结果",
    projectId: "loomhelm",
    taskId: "LH-35",
    execution: "待核对" as const,
    preview: "候选版本已经结束，结果需要人工确认。",
    updated: "今天 09:42",
    history: [
      {
        id: "C-103-1",
        role: "assistant" as const,
        label: "Codex · 主对话",
        text: "执行已结束，但这不自动证明任务完成。请先核对候选身份和健康检查。"
      }
    ]
  },
  {
    id: "C-104",
    title: "补充文档索引",
    projectId: "sidecar",
    taskId: "SN-12",
    execution: "待输入" as const,
    preview: "需要一份项目范围内的文档入口。",
    updated: "昨天",
    history: [
      {
        id: "C-104-1",
        role: "assistant" as const,
        label: "Codex · 主对话",
        text: "我已经整理出缺口，请补充希望保留的文档范围。"
      }
    ]
  },
  {
    id: "C-105",
    title: "整理研究结论",
    projectId: "sidecar",
    taskId: "SN-18",
    execution: "已结束" as const,
    preview: "结论已写回对话上下文。",
    updated: "周一",
    history: [
      {
        id: "C-105-1",
        role: "assistant" as const,
        label: "Codex · 主对话",
        text: "研究结论已经整理完毕，未创建独立的产物入口。"
      }
    ]
  },
  {
    id: "C-106",
    title: "验证设备工作流",
    projectId: "device-lab",
    taskId: "DL-08",
    execution: "执行中" as const,
    preview: "正在对照跨项目父任务和前置依赖。",
    updated: "12 分钟前",
    history: [
      {
        id: "C-106-1",
        role: "assistant" as const,
        label: "Codex · 主对话",
        text: "Device Lab 的任务保留自己的项目归属，同时引用 Loomhelm 的父任务和 Sidecar 的前置任务。",
        detail: "父子关系与前置依赖是两种不同关系。"
      }
    ]
  },
  {
    id: "C-107",
    title: "同步实验记录",
    projectId: "device-lab",
    taskId: "DL-11",
    execution: "未开始" as const,
    preview: "等待验证工作流完成后继续。",
    updated: "今天 08:16",
    history: []
  },
  {
    id: "C-108",
    title: "今日想法：先梳理用户路径",
    execution: "已连接" as const,
    preview: "一段还没有归属项目的独立对话。",
    updated: "刚刚",
    history: [
      {
        id: "C-108-1",
        role: "user" as const,
        label: "你",
        text: "先把工作台和任务之间的路径梳理清楚。"
      },
      {
        id: "C-108-2",
        role: "assistant" as const,
        label: "Codex · 主对话",
        text: "可以先从待介入事项开始，再进入任务工作区。"
      }
    ]
  },
  {
    id: "C-109",
    title: "未关联的调研笔记",
    projectId: "sidecar",
    execution: "已连接" as const,
    preview: "项目内的对话叶子，不插入任务层。",
    updated: "周二",
    history: [
      {
        id: "C-109-1",
        role: "user" as const,
        label: "你",
        text: "这些笔记暂时留在 Sidecar Notes 项目里。"
      }
    ]
  }
];

const attention = [
  {
    id: "approval-1",
    kind: "审批" as const,
    title: "允许读取 Loomhelm 工作区",
    summary: "Codex 正在等待一次明确的工作区访问审批。",
    taskId: "LH-30",
    conversationId: "C-101",
    command: "codex inspect --workspace /workspace/loomhelm --write-report",
    directory: "/workspace/loomhelm",
    impact: "会读取当前任务上下文，并写入一份本地校验报告。",
    status: "pending" as const
  },
  {
    id: "input-1",
    kind: "需要输入" as const,
    title: "补充文档索引范围",
    summary: "Sidecar Notes 的任务缺少需要保留的文档范围。",
    taskId: "SN-12",
    conversationId: "C-104",
    impact: "补充内容只会作为当前对话的下一条输入，不会自动发送。",
    status: "pending" as const
  },
  {
    id: "result-1",
    kind: "结果待核对" as const,
    title: "核对蓝绿候选版本",
    summary: "执行已结束，但结果身份还需要人工确认。",
    taskId: "LH-35",
    conversationId: "C-103",
    command: "release candidate: f3f065f",
    directory: "/workspace/loomhelm",
    impact: "任务业务状态保持独立，不会因为一次执行结束而自动完成。",
    status: "pending" as const
  }
];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function filterForPersona(
  fixture: DemoFixtures,
  persona: DemoPersona,
  dataMode: DemoDataMode
): DemoFixtures {
  if (dataMode === "empty") {
    return { projects: clone(projects), tasks: [], conversations: [], attention: [] };
  }

  const next = clone(fixture);
  if (dataMode === "sparse") {
    next.tasks = next.tasks.slice(0, 4);
    next.conversations = next.conversations.slice(0, 5);
    next.attention = next.attention.slice(0, 1);
  }

  if (persona === "viewer") {
    next.attention = next.attention.map((item) => ({ ...item, status: "resolved" as const }));
  }

  return next;
}

export function createDemoFixtures(
  persona: DemoPersona = "owner",
  dataMode: DemoDataMode = "full"
): DemoFixtures {
  return filterForPersona(
    {
      projects: clone(projects),
      tasks: clone(tasks),
      conversations: clone(conversations),
      attention: clone(attention)
    },
    persona,
    dataMode
  );
}

export function applyPermissionFixture(fixtures: DemoFixtures, persona: DemoPersona): DemoFixtures {
  if (persona !== "viewer") return fixtures;

  const allowedProjects = new Set(["loomhelm", "device-lab"]);
  return {
    projects: fixtures.projects.filter((project) => allowedProjects.has(project.id)),
    tasks: fixtures.tasks
      .filter((task) => allowedProjects.has(task.projectId))
      .map((task) => ({
        ...task,
        parentId: task.parentId && fixtures.tasks.some((parent) => parent.id === task.parentId && allowedProjects.has(parent.projectId)) ? task.parentId : undefined,
        dependsOn: task.dependsOn.filter((id) => fixtures.tasks.some((dependency) => dependency.id === id && allowedProjects.has(dependency.projectId)))
      })),
    conversations: fixtures.conversations.filter((conversation) => !conversation.projectId || allowedProjects.has(conversation.projectId)),
    attention: fixtures.attention.filter((item) => fixtures.tasks.some((task) => task.id === item.taskId && allowedProjects.has(task.projectId)))
  };
}

export function createFixturesForState(
  persona: DemoPersona,
  dataMode: DemoDataMode,
  permissionChanged: boolean
): DemoFixtures {
  const fixtures = createDemoFixtures(persona, dataMode);
  return permissionChanged ? applyPermissionFixture(fixtures, "viewer") : fixtures;
}
