import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const text = z.string().trim().min(1);
const timestamp = z.iso.datetime({ offset: false });

export const atomicExternalRef = z
  .object({ provider: text, repository: text, id: text, url: z.url().optional() })
  .strict();

export const atomicTaskScope = z
  .object({ kind: z.literal("task"), task_id: id, delivery_unit_id: id })
  .strict();
export const atomicDeliveryUnitScope = z
  .object({ kind: z.literal("delivery_unit"), delivery_unit_id: id })
  .strict();
export const atomicScope = z.discriminatedUnion("kind", [atomicTaskScope, atomicDeliveryUnitScope]);

export const atomicBlocker = z
  .object({ code: text, message: text, evidence_refs: z.array(text).default([]) })
  .strict();
export const atomicCriterion = z
  .object({ id, statement: text, evidence_kind: z.enum(["artifact", "provider_receipt", "quality", "online_verification"]) })
  .strict();
export const atomicRuntime = z
  .object({ started_at: timestamp, updated_at: timestamp, evidence_refs: z.array(text).default([]) })
  .strict();
export const atomicResult = z
  .object({ completed_at: timestamp, evidence_refs: z.array(text).min(1) })
  .strict();

const workDefinition = z
  .object({ kind: z.literal("work"), id, title: text, purpose: text, output: text, acceptance: z.array(atomicCriterion) })
  .strict();
const workLifecycle = <T extends z.ZodTypeAny>(scope: T) =>
  z.discriminatedUnion("state", [
    z.object({ state: z.literal("design") }).strict(),
    z.object({ state: z.literal("planned"), scope }).strict(),
    z.object({ state: z.literal("starting"), scope, runtime: atomicRuntime }).strict(),
    z.object({ state: z.literal("running"), scope, runtime: atomicRuntime }).strict(),
    z.object({ state: z.literal("blocked"), scope, runtime: atomicRuntime, blocker: atomicBlocker }).strict(),
    z.object({ state: z.literal("completed"), scope, runtime: atomicRuntime, result: atomicResult }).strict(),
  ]);

export const atomicWorkNode = z.union([
  z.intersection(workDefinition.extend({ activity_type: z.enum(["contribution", "documentation"]) }), workLifecycle(atomicTaskScope)),
  z.intersection(workDefinition.extend({ activity_type: z.enum(["verification", "release", "deployment"]) }), workLifecycle(atomicScope)),
]);

export const milestoneCriterion = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node_satisfied"), node_id: id }).strict(),
  z.object({ kind: z.literal("pr_published"), pr_ref: atomicExternalRef }).strict(),
  z.object({ kind: z.literal("pr_merged"), pr_ref: atomicExternalRef, merge_sha: text }).strict(),
  z.object({ kind: z.literal("ci_passed"), target_ref: text, head_sha: text, checks: z.array(text).min(1) }).strict(),
  z.object({ kind: z.literal("release_published"), release_id: text, artifact_digest: text }).strict(),
  z.object({ kind: z.literal("deployment_succeeded"), environment: text, artifact_digest: text }).strict(),
  z.object({ kind: z.literal("online_verification_passed"), target: text, verification_id: text }).strict(),
]);

export const milestoneNode = z.union([
  z.object({ kind: z.literal("milestone"), id, title: text, state: z.literal("design"), acceptance: z.array(milestoneCriterion) }).strict(),
  z.object({ kind: z.literal("milestone"), id, title: text, state: z.literal("planned"), scope: atomicScope, acceptance: z.array(milestoneCriterion) }).strict(),
]);

export const atomicNode = z.union([atomicWorkNode, milestoneNode]);
export const atomicEdge = z
  .object({
    id,
    from_node_id: id,
    to_node_id: id,
    requires: z.union([
      z.object({ kind: z.literal("source_terminal_success") }).strict(),
      z.object({ kind: z.literal("source_evidence"), criterion: milestoneCriterion }).strict(),
    ]),
  })
  .strict();

export const taskPrBinding = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unbound") }).strict(),
  z.object({ state: z.literal("open"), pr: atomicExternalRef, branch: text, base_branch: text }).strict(),
  z.object({ state: z.literal("merged"), pr: atomicExternalRef, branch: text, merge_sha: text }).strict(),
  z.object({ state: z.literal("closed"), pr: atomicExternalRef, branch: text, closed_at: timestamp, closed_reason: z.enum(["abandoned", "superseded", "provider_closed", "replaced"]) }).strict(),
]);

export const deliveryUnitExternalFacts = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unpublished") }).strict(),
  z.object({ state: z.literal("published"), pr: atomicExternalRef, parent_branch: text }).strict(),
  z.object({ state: z.literal("merged"), pr: atomicExternalRef, parent_branch: text, merge_sha: text }).strict(),
  z.object({ state: z.literal("closed"), pr: atomicExternalRef, parent_branch: text, closed_at: timestamp, closed_reason: z.enum(["abandoned", "superseded", "provider_closed", "replaced"]) }).strict(),
]);

export type AtomicNode = z.infer<typeof atomicNode>;
export type AtomicEdge = z.infer<typeof atomicEdge>;
export type TaskPrBinding = z.infer<typeof taskPrBinding>;
export type DeliveryUnitExternalFacts = z.infer<typeof deliveryUnitExternalFacts>;
export type ContributionStartContext = {
  delivery_unit_kind?: "bootstrap" | "regular";
  owner_kind?: "main" | "group";
  execution_owner?: "main" | "delivery_agent" | "task_agent";
  conversation_policy?: "main_owned" | "delivery_owned" | "task_agent" | "none";
  active?: boolean;
  workspace_ready?: boolean;
};

export type DerivedBusinessStatus = "planned" | "ready" | "running" | "blocked" | "completed";

export function deriveBusinessStatus(
  nodes: readonly AtomicNode[],
  scope: { kind: "task"; task_id: string } | { kind: "delivery_unit"; delivery_unit_id: string },
  milestoneEvaluations: ReadonlyMap<string, MilestoneEvaluation> = new Map(),
): DerivedBusinessStatus {
  const scoped = nodes.filter((node) => {
    if (node.kind !== "work" || !node.scope) return false;
    return scope.kind === "task"
      ? node.scope.kind === "task" && node.scope.task_id === scope.task_id
      : node.scope.delivery_unit_id === scope.delivery_unit_id;
  });
  const scopedMilestones = nodes.filter((node): node is Extract<AtomicNode, { kind: "milestone" }> => {
    if (node.kind !== "milestone" || !node.scope) return false;
    return scope.kind === "delivery_unit"
      ? node.scope.delivery_unit_id === scope.delivery_unit_id
      : node.scope.kind === "task" && node.scope.task_id === scope.task_id;
  });
  if (!scoped.length && !scopedMilestones.length) return "planned";
  if (scoped.some((node) => node.kind === "work" && node.state === "blocked")) return "blocked";
  if (scopedMilestones.some((node) => {
    const evaluation = milestoneEvaluations.get(node.id);
    return evaluation?.status === "blocked";
  })) return "blocked";
  if (scoped.every((node) => node.kind === "work" && node.state === "completed") && scopedMilestones.every((node) => milestoneEvaluations.get(node.id)?.status === "satisfied")) return "completed";
  if (scoped.some((node) => node.kind === "work" && (node.state === "running" || node.state === "starting"))) return "running";
  if (scoped.some((node) => node.kind === "work" && node.state === "planned")) return "ready";
  return "planned";
}

export function validateContributionStart(
  node: AtomicNode,
  deliveryUnit: { pr: DeliveryUnitExternalFacts; parent_branch?: string | null },
  context: ContributionStartContext = {},
): void {
  if (node.kind !== "work" || node.activity_type !== "contribution" || node.state !== "starting") return;
  const bootstrapException =
    context.delivery_unit_kind === "bootstrap" &&
    context.owner_kind === "main" &&
    context.execution_owner === "main" &&
    context.conversation_policy === "main_owned" &&
    context.active === true &&
    context.workspace_ready === true;
  if (!bootstrapException && deliveryUnit.pr.state !== "published" && deliveryUnit.pr.state !== "merged") throw new Error("Contribution work requires a published DeliveryUnit PR before starting");
  if (!bootstrapException && !deliveryUnit.parent_branch) throw new Error("Contribution work requires a DeliveryUnit parent branch before starting");
}

export type MilestoneEvaluation =
  | { status: "pending"; unmet: string[]; evidence_refs: string[] }
  | { status: "satisfied"; evidence_refs: string[]; satisfied_at: string }
  | { status: "blocked"; blockers: z.infer<typeof atomicBlocker>[]; evidence_refs: string[] };

export function validateAtomicGraph(nodes: readonly AtomicNode[], edges: readonly AtomicEdge[]): void {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error(`Duplicate atomic node: ${node.id}`);
    ids.add(node.id);
  }
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!ids.has(edge.from_node_id) || !ids.has(edge.to_node_id)) throw new Error(`Atomic edge references missing node: ${edge.id}`);
    const list = outgoing.get(edge.from_node_id) ?? [];
    list.push(edge.to_node_id);
    outgoing.set(edge.from_node_id, list);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) throw new Error("Atomic graph must be acyclic");
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const target of outgoing.get(nodeId) ?? []) visit(target);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of nodes) visit(node.id);
  for (const node of nodes) {
    if (node.kind === "milestone" && node.state === "planned") {
      const incoming = edges.filter((edge) => edge.to_node_id === node.id);
      if (!incoming.length && !node.acceptance.length) throw new Error(`Planned milestone ${node.id} must have conditions`);
    }
  }
}

export function evaluateMilestone(
  node: Extract<AtomicNode, { kind: "milestone" }>,
  incoming: readonly { satisfied: boolean; blocked?: boolean; evidence_refs?: string[] }[],
  acceptance: readonly { satisfied: boolean; blocked?: boolean; evidence_refs?: string[] }[],
  now = new Date().toISOString(),
): MilestoneEvaluation {
  const conditions = [...incoming, ...acceptance];
  if (!conditions.length) throw new Error(`Milestone ${node.id} has no conditions`);
  const evidence_refs = conditions.flatMap((condition) => condition.evidence_refs ?? []);
  if (conditions.some((condition) => condition.blocked)) return { status: "blocked", blockers: [{ code: "MILESTONE_CONDITION_FAILED", message: `Milestone ${node.id} has a failed condition`, evidence_refs }], evidence_refs };
  if (conditions.every((condition) => condition.satisfied)) return { status: "satisfied", evidence_refs, satisfied_at: now };
  return { status: "pending", unmet: conditions.map((_, index) => String(index)).filter((_, index) => !conditions[index]!.satisfied), evidence_refs };
}

export function migrateLegacyTaskAtoms(raw: any): any[] {
  const groups = Array.isArray(raw?.groups) ? raw.groups : [];
  if (groups.some((group: any) => Array.isArray(group?.atoms) && group.atoms.length))
    throw new Error("Legacy Group.atoms has ambiguous semantics; explicit plan revision is required");
  const tasks = Array.isArray(raw?.tasks) ? raw.tasks : [];
  return tasks.flatMap((task: any) =>
    (Array.isArray(task?.atoms) ? task.atoms : []).map((atom: any) => {
      const state = atom.status === "completed" ? "completed" : atom.status === "blocked" ? "blocked" : atom.status === "running" ? "running" : "planned";
      const scope = { kind: "task", task_id: task.id, delivery_unit_id: task.group_id };
      if (state === "planned") return { kind: "work", id: atom.id, title: atom.title, purpose: atom.title, output: atom.title, acceptance: [], activity_type: "contribution", state, scope };
      const runtime = { started_at: task.started_at ?? new Date(0).toISOString(), updated_at: task.finished_at ?? task.started_at ?? new Date(0).toISOString(), evidence_refs: [] };
      if (state === "completed") return { kind: "work", id: atom.id, title: atom.title, purpose: atom.title, output: atom.title, acceptance: [], activity_type: "contribution", state, scope, runtime, result: { completed_at: task.finished_at ?? runtime.updated_at, evidence_refs: ["legacy:task:" + task.id] } };
      if (state === "blocked") return { kind: "work", id: atom.id, title: atom.title, purpose: atom.title, output: atom.title, acceptance: [], activity_type: "contribution", state, scope, runtime, blocker: { code: "LEGACY_BLOCKED", message: task.blocker ?? "Legacy task was blocked", evidence_refs: [] } };
      return { kind: "work", id: atom.id, title: atom.title, purpose: atom.title, output: atom.title, acceptance: [], activity_type: "contribution", state, scope, runtime };
    }),
  );
}

export function contract3MigrationCandidate(raw: any): any {
  const candidate = structuredClone(raw);
  const legacyNodes = migrateLegacyTaskAtoms(raw);
  const legacyEdges = Array.isArray(raw?.plans?.[0]?.atomic_edges) ? raw.plans[0].atomic_edges : [];
  const canonicalEdges = legacyEdges
    .filter((edge: any) => edge && typeof edge.from_atom_id === "string" && typeof edge.to_atom_id === "string")
    .map((edge: any) => ({ id: edge.id, from_node_id: edge.from_atom_id, to_node_id: edge.to_atom_id, requires: { kind: "source_terminal_success" } }));
  candidate.contract_version = 3;
  candidate.groups = Array.isArray(candidate.groups) ? candidate.groups.map((group: any) => {
    if (group.pr && typeof group.pr.state === "string") return group;
    if (group.parent_pr) {
      const state = group.state === "merged" ? "merged" : group.state === "closed" ? "closed" : "published";
      return { ...group, pr: state === "merged" ? { state, pr: group.parent_pr, parent_branch: group.parent_branch ?? "main", merge_sha: group.merge_sha ?? "0000000000000000000000000000000000000000" } : state === "closed" ? { state, pr: group.parent_pr, parent_branch: group.parent_branch ?? "main", closed_at: group.finished_at ?? new Date(0).toISOString(), closed_reason: "provider_closed" } : { state, pr: group.parent_pr, parent_branch: group.parent_branch ?? "main" } };
    }
    return { ...group, pr: { state: "unpublished" } };
  }) : candidate.groups;
  candidate.tasks = Array.isArray(candidate.tasks) ? candidate.tasks.map((task: any) => {
    if (task.pr && typeof task.pr.state === "string") return task;
    if (task.pr && task.branch && task.base_branch) {
      const state = task.state === "integrated" || task.state === "completed" ? "merged" : task.state === "closed" ? "closed" : "open";
      return { ...task, pr: state === "merged" ? { state, pr: task.pr, branch: task.branch, merge_sha: task.merge_sha ?? "0000000000000000000000000000000000000000" } : state === "closed" ? { state, pr: task.pr, branch: task.branch, closed_at: task.finished_at ?? new Date(0).toISOString(), closed_reason: "provider_closed" } : { state, pr: task.pr, branch: task.branch, base_branch: task.base_branch } };
    }
    return { ...task, pr: { state: "unbound" } };
  }) : candidate.tasks;
  candidate.atomic_nodes = Array.isArray(raw?.atomic_nodes) && raw.atomic_nodes.length ? raw.atomic_nodes : legacyNodes;
  candidate.atomic_edges = Array.isArray(raw?.atomic_edges) && raw.atomic_edges.length ? raw.atomic_edges : canonicalEdges;
  candidate.plans = Array.isArray(candidate.plans)
    ? candidate.plans.map((plan: any) => ({
        ...plan,
        atomic_nodes: Array.isArray(plan.atomic_nodes) && plan.atomic_nodes.length ? plan.atomic_nodes : candidate.atomic_nodes,
        atomic_edges: Array.isArray(plan.atomic_edges) && plan.atomic_edges.some((edge: any) => edge?.from_node_id) ? plan.atomic_edges : candidate.atomic_edges,
      }))
    : candidate.plans;
  return candidate;
}
