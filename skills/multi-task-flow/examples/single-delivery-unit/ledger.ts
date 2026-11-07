import { defaultGroupAtoms, validateLedger, type Ledger } from "../../scripts/schema";

export const singleDeliveryUnitId = "single-delivery-unit";
export const singleDeliveryUnitName = "文档检索服务 · 单交付单元示例";

/** Fully synthetic fixture: no real run, repository, conversation, or PR data. */
export function createSingleDeliveryUnitLedger(): Ledger {
  const at = (minutes: number) => new Date(Date.parse("2026-01-15T08:00:00Z") + minutes * 60_000).toISOString();
  const groupId = "search-service";
  const mockSha = "a".repeat(40);
  const mockPr = (id: number) => ({ provider: "github", repository: "example/document-search-demo", id: String(id), url: `https://example.invalid/document-search-demo/pull/${id}` });
  const schedule: Record<string, [number, number | null]> = {
    contract: [0, 30], storage: [0, 40], writer: [40, 65], reader: [40, 65],
    gateway: [65, 90], importer: [65, 90], container: [90, null],
  };
  const rows = [
    ["contract", "检索协议与领域模型", "contribution", "integrated", 60],
    ["storage", "文档存储与索引结构", "contribution", "integrated", 90],
    ["writer", "索引写入与批量更新", "contribution", "integrated", 120],
    ["reader", "查询执行与结果排序", "contribution", "integrated", 120],
    ["gateway", "检索接口与权限校验", "contribution", "integrated", 90],
    ["importer", "历史文档导入工具", "contribution", "integrated", 90],
    ["container", "容器构建与启动配置", "contribution", "running", 60],
    ["switch", "索引切换与回退策略", "contribution", "planned", 90],
    ["recovery", "故障恢复与重建验证", "contribution", "planned", 90],
    ["acceptance", "端到端检索验收", "contribution", "planned", 120],
    ["integration", "交付集成与质量核对", "contribution", "planned", 60],
    ["publish", "发布检索服务版本", "release", "planned", 30],
    ["deploy", "部署演示环境", "deployment", "planned", 30],
    ["verify", "上线检索与健康验证", "verification", "planned", 30],
  ] as const;
  const tasks = rows.map(([id, title, kind, state], index) => ({
    id, title, kind, state, group_id: groupId, thread_id: state === "planned" ? null : `mock-thread-${id}`,
    atoms: [{ id: `atom-${id}`, title, status: state === "integrated" ? "completed" : state === "running" ? "running" : "planned" }],
    owned_surfaces: [title], base_sha: kind === "contribution" ? mockSha : null,
    branch: state === "planned" ? null : `mock/${id}`,
    pr: state === "planned" ? null : mockPr(101 + index), requirements_path: null,
    lifecycle: { workspace_ready: state === "planned" ? "pending" : "passed", pr_created: state === "planned" ? "pending" : "passed", pr_merged: state === "integrated" ? "passed" : "pending", closed: "pending" },
    started_at: schedule[id] ? at(schedule[id]![0]) : null,
    finished_at: schedule[id]?.[1] != null ? at(schedule[id]![1]!) : null,
    blocker: null, assignment_history: [],
  }));
  const groupAtoms = defaultGroupAtoms(groupId).map((atom, index) => ({ ...atom, status: index < 2 ? "completed" as const : "planned" as const }));
  const events: Ledger["events"] = [
    { id: "mock-approved", type: "plan_approved", subject_id: "mock-search-plan", actor_id: "mock-owner", occurred_at: at(-30), recorded_at: at(-30), data: { approval_id: "mock-approval" } },
    { id: "mock-unit-started", type: "group_updated", subject_id: groupId, actor_id: "mock-owner", occurred_at: at(-15), recorded_at: at(-15), data: { group_id: groupId, state: "active" } },
    ...tasks.flatMap(task => !task.started_at ? [] : [
      { id: `mock-start-${task.id}`, type: "task_started" as const, subject_id: task.id, actor_id: "mock-coordinator", occurred_at: task.started_at, recorded_at: task.started_at, data: { task_id: task.id, group_id: groupId, state: "running" } },
      ...(task.finished_at ? [{ id: `mock-integrated-${task.id}`, type: "merge_resolved" as const, subject_id: groupId, actor_id: "mock-coordinator", occurred_at: task.finished_at, recorded_at: task.finished_at, data: { task_id: task.id, group_id: groupId, outcome: "succeeded" } },
        { id: `mock-atom-${task.id}`, type: "atom_updated" as const, subject_id: task.id, actor_id: "mock-coordinator", occurred_at: task.finished_at, recorded_at: task.finished_at, data: { task_id: task.id, atom_id: `atom-${task.id}`, state: "completed" } }] : []),
    ]),
  ];
  const prepared = [
    { id: groupId, branch: "mock/search-service", pr: mockPr(100), start: at(-20), finish: null },
    ...tasks.filter(task => task.started_at).map(task => ({ id: task.id, branch: task.branch!, pr: task.pr!, start: task.started_at!, finish: task.finished_at })),
  ];
  const facts: Ledger["facts"] = [];
  for (const item of prepared) {
    events.push({ id: `mock-workspace-${item.id}`, type: "lifecycle_recorded", subject_id: item.id, actor_id: "mock-coordinator", occurred_at: item.start, recorded_at: item.start, data: { stage: "workspace_ready", state: "passed" } });
    facts.push({ id: `mock-pr-${item.id}`, kind: "pr_published", subject_id: item.id, status: "passed", source: "mock", observed_at: item.start, sha: mockSha, evidence_ref: `mock:${item.id}:pr`,
      receipt: { provider: "github", repository: "example/document-search-demo", resource_type: "pr", resource_id: item.pr.id, branch: item.branch,
        target_branch: item.id === groupId ? "main" : "mock/search-service", base_sha: mockSha, head_sha: mockSha, pr: item.pr, state: "open", evidence_ref: `mock:${item.id}:pr` },
    });
    if (item.finish) facts.push({ id: `mock-merge-${item.id}`, kind: "pr_merged", subject_id: item.id, status: "passed", source: "mock", observed_at: item.finish, sha: mockSha, evidence_ref: `mock:${item.id}:merge` });
  }
  for (const [index, atom] of groupAtoms.entries()) if (atom.status === "completed") events.push({ id: `mock-group-atom-${index}`, type: "group_atom_updated", subject_id: groupId, actor_id: "mock-coordinator", occurred_at: at(-20 + index * 5), recorded_at: at(-20 + index * 5), data: { group_id: groupId, atom_id: atom.id, state: "completed" } });
  events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const node = (id: string, kind: string, ref: string | null, label: string, estimate = 0) => ({
    id, kind, ref_id: ref, group_id: kind.startsWith("main_") ? null : groupId,
    label, estimate_minutes: estimate, estimate_basis: estimate ? "示例估时" : null,
    estimate_confidence: estimate ? "medium" : null,
  });
  const nodes = [
    node("start", "main_start", null, "开始"),
    node("unit-start", "group_start", groupId, "交付单元开始"),
    ...rows.map(([id, title, , , minutes]) => node(id, "task", id, title, minutes)),
    node("merged", "milestone", groupId, "父 PR 合并", 15),
    node("ready", "milestone", null, "发布就绪", 15),
    node("unit-end", "group_end", groupId, "交付单元收口"),
    node("end", "main_end", null, "完成"),
  ];
  const links: Array<[string, string, string]> = [
    ["start", "unit-start", "completed"], ["unit-start", "contract", "completed"],
    ["unit-start", "storage", "completed"], ["contract", "writer", "integrated"],
    ["storage", "writer", "integrated"], ["contract", "reader", "integrated"],
    ["storage", "reader", "integrated"], ["writer", "gateway", "integrated"],
    ["reader", "gateway", "integrated"], ["writer", "importer", "integrated"],
    ["storage", "container", "integrated"], ["gateway", "container", "integrated"],
    ["writer", "switch", "integrated"], ["reader", "switch", "integrated"],
    ["importer", "switch", "integrated"], ["importer", "recovery", "integrated"],
    ["switch", "recovery", "integrated"], ["container", "recovery", "integrated"],
    ["gateway", "acceptance", "integrated"], ["reader", "acceptance", "integrated"],
    ["switch", "acceptance", "integrated"], ["container", "acceptance", "integrated"],
    ["recovery", "integration", "integrated"], ["acceptance", "integration", "integrated"],
    ["integration", "merged", "integrated"], ["merged", "ready", "merged"],
    ["ready", "publish", "completed"], ["publish", "deploy", "published"],
    ["deploy", "verify", "deployed"], ["verify", "unit-end", "completed"],
    ["unit-end", "end", "completed"],
  ];
  return validateLedger({
    schema_version: 2, contract_version: 2, orchestration_id: singleDeliveryUnitId, revision: 1,
    repository: { provider: "github", host: "example.invalid", owner: "example", name: "document-search-demo", target_branch: "main" },
    control: { owner_thread_id: "mock-thread-main", ownership: "bound", approval_id: "mock-approval" },
    config: { max_running_tasks: 3, display_timezone: "Asia/Shanghai", conversation_links_verified: false, execution_profile: { model: "gpt-6.1-sol", thinking: "medium" } },
    plans: [{ id: "mock-search-plan", supersedes_id: null, approval_id: "mock-approval", lifecycle: "approved", created_at: at(-30), start_at: at(0),
      atoms: tasks.map(task => ({ id: `atom-${task.id}`, title: task.title, task_id: task.id, purpose: task.title, output: `模拟产物：${task.title}` })),
      group_atoms: groupAtoms.map(({ status: _status, ...atom }) => ({ ...atom, group_id: groupId })),
      atomic_edges: [], nodes, edges: links.map(([from, to, requires], index) => ({ id: `dependency-${index}`, from_node_id: from, to_node_id: to, requires })), cut_rules: [], actions: [],
    }],
    active_plan_id: "mock-search-plan", execution_plan_id: "mock-search-plan",
    groups: [{ id: groupId, title: "文档检索服务", state: "active", agent_thread_id: "mock-thread-search-service",
      parent_branch: "mock/search-service", parent_pr: mockPr(100), cut_sha: null, current_sha: mockSha, merge_sha: null,
      lifecycle: { workspace_ready: "passed", pr_created: "passed", pr_merged: "pending", closed: "pending" },
      coordination_execution: { state: "waiting", reason: "父分支与父 PR 已准备，6 项贡献已集成；等待容器配置及后续验收完成。", waiting_for_task_ids: ["container", "switch", "recovery", "acceptance", "integration"] },
      requirements_path: null, atoms: groupAtoms,
    }], tasks, follow_prs: [], facts, operations: [], events, requests: [], notifications: [], resources: [], updated_at: at(120),
  });
}
