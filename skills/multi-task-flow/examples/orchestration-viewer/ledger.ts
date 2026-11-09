import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateLedger, type Ledger } from "../../lib/schema";

type LinkVerification = { schema_version: 1; method: string; verified_at: string; evidence_ref: string; results: { thread_id: string; navigated: boolean }[] };
const linkVerification = JSON.parse(readFileSync(join(import.meta.dir, "link-verification.json"), "utf8")) as LinkVerification;

/** Committed dashboard fixture using real workspace conversations as link fixtures. */
export function createDemoLedger(referenceTime = Date.now()): Ledger {
  const now = Math.floor(referenceTime / 60_000) * 60_000;
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const firstSha = "a".repeat(40), mergeSha = "b".repeat(40), nextSha = "c".repeat(40);
  const repository = "sample/multi-task-flow";
  const pr = (id: string) => ({ provider: "github", repository, id, url: null });
  const conversations = {
    main: "01a18bf3-feb7-7d52-98b3-dc25f8549f69",
    core: "01a14809-f2f6-75d0-81f1-72ab8eccb5fa",
    dashboard: "01a18e2c-89e7-75e2-9dd5-941ff028de77",
    model: "01a17446-5c36-7210-b444-4cc42e214bb9",
    ledger: "01a17b7f-1da1-7ae3-8b4e-63e730d88b1b",
    scheduler: "01a187e1-2733-7be2-acf9-2afb16a40220",
    release: "01a186c5-3685-7633-8574-d037c70cc54c",
    deploy: "01a1852d-fc21-7060-8574-91505764f8a9",
    dashboardUi: "01a16be6-a5e5-7343-9267-bd11bdf4e57d",
    server: "01a17bb7-51ec-7832-9211-608e2789c4ba",
    integration: "01a14ad0-3362-7dd0-bc63-e78aae2f0e88",
  } as const;
  const linkIds = Object.values(conversations);
  const linkEvidenceIds = linkVerification.results.filter((result) => result.navigated).map((result) => result.thread_id);
  const linksVerified = linkVerification.results.length === linkIds.length && new Set(linkEvidenceIds).size === linkIds.length && linkIds.every((id) => linkEvidenceIds.includes(id));
  const groupAtoms = (groupId: string) => [
    { id: `group-atom-${groupId}-1`, title: "准备父分支", group_id: groupId, purpose: "建立交付单元父分支", output: "父分支已准备", lifecycle_stage: "workspace_ready" as const },
    { id: `group-atom-${groupId}-2`, title: "创建父 PR", group_id: groupId, purpose: "提交交付单元父 PR", output: "父 PR 已创建", lifecycle_stage: "pr_created" as const },
    { id: `group-atom-${groupId}-3`, title: "验收集成结果", group_id: groupId, purpose: "核对贡献任务集成结果", output: "集成结果已验收", lifecycle_stage: null },
    { id: `group-atom-${groupId}-4`, title: "合并父 PR", group_id: groupId, purpose: "合并已验收的父 PR", output: "父 PR 已合并", lifecycle_stage: "pr_merged" as const },
    { id: `group-atom-${groupId}-5`, title: "收口", group_id: groupId, purpose: "完成交付单元收口", output: "交付单元已收口", lifecycle_stage: "closed" as const },
  ];
  const runtimeAtoms = (groupId: string, completed: number, running: number | null) => groupAtoms(groupId).map(({ group_id: _groupId, ...atom }, index) => ({ ...atom, status: index < completed ? "completed" as const : index === running ? "running" as const : "planned" as const }));
  const coreAtoms = runtimeAtoms("core", 4, null);
  const dashboardAtoms = runtimeAtoms("dashboard", 2, 2);
  const groups = [
    { id: "core", title: "账本与依赖调度", agent_thread_id: conversations.core, state: "merged", parent_branch: "orchestration/core", parent_pr: pr("101"), cut_sha: firstSha, current_sha: firstSha, merge_sha: mergeSha, requirements_path: "requirements/group-core.md", atoms: coreAtoms, coordination_execution: { state: "idle" as const, reason: null, waiting_for_task_ids: [] } },
    { id: "dashboard", title: "编排展示与交互验收", agent_thread_id: conversations.dashboard, state: "active", parent_branch: "orchestration/dashboard", parent_pr: pr("110"), cut_sha: null, current_sha: nextSha, merge_sha: null, requirements_path: "requirements/group-dashboard.md", atoms: dashboardAtoms, coordination_execution: { state: "waiting" as const, reason: "等待贡献任务完成集成结果", waiting_for_task_ids: ["integration"] } },
  ];
  const rows = [
    { id: "model", title: "依赖模型与任务图", group: "core", kind: "contribution", state: "closed", start: -1020, finish: -750, duration: 240, surfaces: ["账本数据模型", "依赖图校验"] },
    { id: "ledger", title: "账本持久化与并发控制", group: "core", kind: "contribution", state: "closed", start: -1010, finish: -650, duration: 300, surfaces: ["JSON 账本", "原子写入", "锁与恢复"] },
    { id: "scheduler", title: "调度与 PR 合并协调", group: "core", kind: "contribution", state: "integrated", start: -640, finish: -350, duration: 360, surfaces: ["前驱事实", "合并占用", "切割围栏"] },
    { id: "release", title: "核心能力版本发布", group: "core", kind: "release", state: "completed", start: -300, finish: -240, duration: 60, surfaces: ["版本发布"] },
    { id: "deploy", title: "运行环境部署与验证", group: "core", kind: "deployment", state: "running", start: -220, finish: null, duration: 120, surfaces: ["部署环境"] },
    { id: "verify", title: "发布后核心能力验证", group: "core", kind: "verification", state: "planned", start: null, finish: null, duration: 90, surfaces: ["版本验证"] },
    { id: "dashboard-ui", title: "依赖图与甘特图交互验证", group: "dashboard", kind: "contribution", state: "running", start: -550, finish: null, duration: 420, surfaces: ["依赖图", "理论与实际甘特图"], moved: true },
    { id: "server", title: "只读视图服务与实时更新", group: "dashboard", kind: "contribution", state: "running", start: -280, finish: null, duration: 300, surfaces: ["本机服务", "事件推送"] },
    { id: "integration", title: "动态切割端到端验证", group: "dashboard", kind: "contribution", state: "blocked", start: null, finish: null, duration: 240, surfaces: ["切割与后续任务回放"], blocker: "等待代码托管平台确认合并结果" },
    { id: "acceptance", title: "页面验收与发布核对", group: "dashboard", kind: "verification", state: "planned", start: null, finish: null, duration: 120, surfaces: ["移动端", "链接与发布核对"] },
  ];
  const taskThreads: Record<string, string> = { model: conversations.model, ledger: conversations.ledger, scheduler: conversations.scheduler, release: conversations.release, deploy: conversations.deploy, "dashboard-ui": conversations.dashboardUi, server: conversations.server, integration: conversations.integration };
  const agentOutputs: Record<string, string> = {
    model: "依赖节点和交付单元起点已完成校验，正在整理可分享的依赖关系事实。",
    ledger: "账本锁与原子写入已完成，正在等待调度事实。",
    scheduler: "调度占用与前驱事实已核对，正在等待父 PR 边界确认。",
    release: "版本发布事实已记录，正在等待部署环境返回可核验结果。",
    deploy: "部署环境已就绪，正在回收运行日志与健康检查结果。",
    "dashboard-ui": "时间轴交互已接入，正在验证切换视图后的状态恢复、窗口持久化和焦点回收。",
    server: "只读视图服务已启动，正在监听账本修订并准备推送最新快照。",
  };
  const tasks = rows.map((row) => ({ id: row.id, title: row.title, kind: row.kind, group_id: row.group, thread_id: row.start === null && row.state !== "blocked" ? null : taskThreads[row.id] ?? null, state: row.state, atoms: [{ id: `atom-${row.id}`, title: row.title, status: ["closed", "integrated", "completed"].includes(row.state) ? "completed" : row.state === "running" ? "running" : row.state === "blocked" && row.start !== null ? "blocked" : "planned" }], owned_surfaces: row.surfaces, base_sha: row.kind === "contribution" ? row.group === "core" ? firstSha : nextSha : null, pr: row.kind === "contribution" && row.start !== null ? pr(`child-${row.id}`) : null, requirements_path: `requirements/task-${row.id}.md`, started_at: row.start === null ? null : at(row.start), finished_at: row.finish === null ? null : at(row.finish), blocker: row.blocker ?? null, assignment_history: row.moved ? [{ group_id: "dashboard", effective_at: at(-330), reason: "dynamic cut", cut_operation_id: "cut-1" }] : [] }));
  const cutTaskSnapshots = tasks
    .filter((task) => ["model", "ledger", "scheduler", "dashboard-ui"].includes(task.id))
    .map((task) => ({
      ...structuredClone(task),
      group_id: "core",
      state: ["model", "ledger", "scheduler"].includes(task.id) ? "integrated" : "running",
      assignment_history: [],
    }));
  const oldGroupBoundary = { ...structuredClone(groups[0]), state: "active", merge_sha: null };
  const newGroupSnapshot = { id: "dashboard", title: "编排展示与交互验收", agent_thread_id: null, state: "planned", parent_branch: null, parent_pr: null, cut_sha: null, current_sha: null, merge_sha: null, requirements_path: null };
  const node = (id: string, kind: string, ref: string | null, group: string | null, label: string, minutes = 0) => ({ id, kind, ref_id: ref, group_id: group, label, estimate_minutes: minutes, estimate_basis: minutes ? "按任务范围估算" : null, estimate_confidence: minutes ? "medium" : null });
  const nodes = [
    node("start", "main_start", null, null, "主任务开始"),
    node("core-start", "group_start", "core", "core", "账本与依赖调度开始"),
    ...rows.filter((row) => row.group === "core" && row.kind === "contribution").map((row) => node(`node-${row.id}`, "task", row.id, row.group, row.title, row.duration)),
    node("core-merge", "milestone", "core", "core", "账本与依赖调度父 PR 合并", 30),
    ...rows.filter((row) => row.group === "core" && row.kind !== "contribution").map((row) => node(`node-${row.id}`, "task", row.id, row.group, row.title, row.duration)),
    node("core-end", "group_end", "core", "core", "账本与依赖调度收口"),
    node("dashboard-start", "group_start", "dashboard", "dashboard", "编排展示与交互验收开始"),
    ...rows.filter((row) => row.group === "dashboard" && row.kind === "contribution").map((row) => node(`node-${row.id}`, "task", row.id, row.moved ? "core" : row.group, row.title, row.duration)),
    node("dashboard-merge", "milestone", "dashboard", "dashboard", "编排展示与交互验收父 PR 合并", 30),
    node("node-acceptance", "task", "acceptance", "dashboard", "页面验收与发布核对", 120),
    node("dashboard-end", "group_end", "dashboard", "dashboard", "编排展示与交互验收收口"),
    node("end", "main_end", null, null, "主任务完成"),
  ];
  const links = [
    ["start", "core-start", "completed"], ["core-start", "node-model", "completed"], ["core-start", "node-ledger", "completed"],
    ["node-model", "node-scheduler", "integrated"], ["node-ledger", "node-scheduler", "integrated"], ["node-scheduler", "core-merge", "integrated"],
    ["core-merge", "node-release", "merged"], ["node-release", "node-deploy", "published"], ["node-deploy", "node-verify", "deployed"], ["node-verify", "core-end", "completed"],
    ["core-merge", "dashboard-start", "merged"], ["dashboard-start", "node-dashboard-ui", "completed"], ["dashboard-start", "node-server", "completed"], ["dashboard-start", "node-integration", "completed"],
    ["node-server", "dashboard-merge", "integrated"], ["node-dashboard-ui", "dashboard-merge", "integrated"], ["node-integration", "dashboard-merge", "integrated"],
    ["dashboard-merge", "node-acceptance", "merged"], ["node-acceptance", "dashboard-end", "completed"], ["core-end", "end", "completed"], ["dashboard-end", "end", "completed"],
  ];
  const edges = links.map(([from, to, requires], index) => ({ id: `edge-${index}`, from_node_id: from, to_node_id: to, requires }));
  const events: unknown[] = [];
  function event(id: string, type: string, subject: string, minutes: number, data: object) { events.push({ id, type, subject_id: subject, actor_id: "sample-agent", occurred_at: at(minutes), recorded_at: at(minutes), data }); }
  event("approval", "plan_approved", "plan-1", -1080, { approval_id: "approved", authorized_actions: ["dispatch", "merge", "cut"], authorized_action_ids: [] });
  event("links-verified", "link_verification", "orchestration-sample", -1075, { verified: linksVerified, evidence_ref: linkVerification.evidence_ref, method: linkVerification.method, verified_at: linkVerification.verified_at });
  event("core-started", "group_updated", "core", -1060, { group_id: "core", state: "active" });
  for (const row of rows) {
    if (row.start !== null) event(`start-${row.id}`, "task_started", row.id, row.start, { task_id: row.id, group_id: row.moved ? "core" : row.group, state: "running", reason: null, ...(agentOutputs[row.id] ? { assistant_output: agentOutputs[row.id] } : {}) });
    if (row.state === "blocked") event(`block-${row.id}`, "task_blocked", row.id, -290, { task_id: row.id, group_id: row.group, state: "blocked", reason: row.blocker });
    if (row.finish !== null) {
      event(`finish-${row.id}`, row.kind === "contribution" ? "merge_resolved" : "task_completed", row.kind === "contribution" ? row.group : row.id, row.finish, { task_id: row.id, group_id: row.group, outcome: "succeeded" });
      event(`atom-finish-${row.id}`, "atom_updated", row.id, row.finish, { task_id: row.id, atom_id: `atom-${row.id}`, state: "completed" });
    }
  }
  event("cut-claim", "cut_claimed", "core", -331, { operation_id: "cut-1", group_id: "core", rule_id: "cut-1", expected_sha: firstSha, drained: true });
  event("cut", "cut_applied", "core", -330, { operation_id: "cut-1", cut_sha: firstSha, cut_evidence: { source: "sample", observed_at: at(-330), sha: firstSha, evidence_ref: "sample-cut" }, old_group_id: "core", old_group_current_sha: firstSha, old_group_snapshot: oldGroupBoundary, new_group_id: "dashboard", new_group_state: "planned", new_group_agent_thread_id: null, new_group_parent_branch: null, new_group_parent_pr: null, new_group_cut_sha: null, new_group_current_sha: null, new_group_merge_sha: null, new_group_requirements_path: null, new_group_snapshot: newGroupSnapshot, included_task_ids: ["model", "ledger", "scheduler"], reassigned_task_ids: ["dashboard-ui"], task_snapshots: cutTaskSnapshots });
  event("dashboard-started", "group_updated", "dashboard", -295, { group_id: "dashboard", state: "active", group_snapshot: structuredClone(groups[1]) });
  events.sort((a: any, b: any) => a.occurred_at.localeCompare(b.occurred_at));
  const fact = (id: string, kind: string, subject_id: string, minutes: number, sha: string) => ({ id, kind, subject_id, status: "passed", source: "sample", observed_at: at(minutes), sha, evidence_ref: `sample-${id}` });
  return validateLedger({
    schema_version: 1, orchestration_id: "orchestration-sample", revision: 18,
    repository: { provider: "github", host: "github.com", owner: "sample", name: "multi-task-flow", target_branch: "main" },
    control: { owner_thread_id: conversations.main, ownership: "bound", approval_id: "approved" },
    config: { execution_profile: { model: "gpt-6.1-sol", thinking: "medium" }, max_running_tasks: 3, display_timezone: "Asia/Shanghai", conversation_links_verified: linksVerified },
    plans: [{ id: "plan-1", supersedes_id: null, approval_id: "approved", created_at: at(-1080), start_at: at(-1050), atoms: rows.map((row) => ({ id: `atom-${row.id}`, title: row.title, task_id: row.id, purpose: row.title, output: row.surfaces.join(", ") })), group_atoms: [...groupAtoms("core"), ...groupAtoms("dashboard")], atomic_edges: [], nodes, edges, cut_rules: [{ id: "cut-1", group_id: "core", priority: 1, required_task_ids: ["model", "ledger", "scheduler"], status: "applied" }], actions: [] }],
    active_plan_id: "plan-1", groups, tasks,
    follow_prs: [{ id: "follow-1", origin_task_id: "scheduler", origin_group_id: "core", pr: pr("follow-1"), target_branch: "main", state: "open", merge_fact_id: null, affected_task_ids: ["integration"] }],
    facts: [fact("parent-merged", "pr_merged", "core", -310, mergeSha), fact("release-published", "published", "release", -240, mergeSha)],
    operations: [{ id: "cut-1", kind: "cut", actor_id: "sample-agent", target_id: "core", status: "succeeded", request: { operation_id: "cut-1", group_id: "core", rule_id: "cut-1", expected_sha: firstSha }, expected_sha: firstSha, receipt_fact_id: null, created_at: at(-331), updated_at: at(-330) }], events, requests: [], notifications: [], resources: [], updated_at: at(0),
  });
}

/** Planning-only dashboard fixture. It shares the plan shape but contains no runtime execution facts. */
export function createPlanningDemoLedger(referenceTime = Date.now()): Ledger {
  const source = createDemoLedger(referenceTime);
  const planning = structuredClone(source);
  const groupSha = new Map([
    ["core", "a".repeat(40)],
    ["dashboard", "c".repeat(40)],
  ]);
  planning.revision = 1;
  planning.groups = planning.groups.map((group) => ({
    ...group,
    state: "active",
    parent_pr: null,
    cut_sha: null,
    current_sha: groupSha.get(group.id) ?? group.current_sha,
    merge_sha: null,
    atoms: group.atoms.map((atom) => ({ ...atom, status: "planned" as const })),
    coordination_execution: { state: "unknown" as const, reason: null, waiting_for_task_ids: [] },
  }));
  planning.tasks = planning.tasks.map((task) => ({
    ...task,
    state: "planned",
    atoms: task.atoms.map((atom) => ({ ...atom, status: "planned" })),
    base_sha: task.kind === "contribution" ? groupSha.get(task.group_id) ?? task.base_sha : null,
    pr: null,
    started_at: null,
    finished_at: null,
    blocker: null,
    assignment_history: [],
  }));
  const taskGroup = new Map(planning.tasks.map((task) => [task.id, task.group_id]));
  planning.plans = planning.plans.map((plan) => ({
    ...plan,
    nodes: plan.nodes.map((node) => node.kind === "task" && node.ref_id
      ? { ...node, group_id: taskGroup.get(node.ref_id) ?? node.group_id }
      : node),
  }));
  planning.follow_prs = [];
  planning.facts = [];
  planning.operations = [];
  planning.events = planning.events.filter((event) => ["plan_approved", "link_verification"].includes(event.type));
  planning.updated_at = new Date(referenceTime).toISOString();
  return validateLedger(planning);
}
