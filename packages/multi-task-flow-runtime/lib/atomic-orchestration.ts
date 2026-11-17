import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const text = z.string().trim().min(1);
const timestamp = z.iso.datetime({ offset: false });

/** Stable semantic identity for the four lifecycle atoms plus the shared PR step. */
export const atomicLifecycleRole = z.enum([
  "prepare-parent",
  "prepare-branch",
  "create-pr",
  "merge-pr",
  "closeout",
]);
export type AtomicLifecycleRole = z.infer<typeof atomicLifecycleRole>;

export type LegacyLifecycleStage =
  | "workspace_ready"
  | "branch_ready"
  | "pr_created"
  | "pr_merged"
  | "closed";

export function lifecycleRoleFromStage(
  stage: LegacyLifecycleStage | null | undefined,
  _scope: "task" | "delivery_unit",
): AtomicLifecycleRole | null {
  if (stage === "workspace_ready") return "prepare-parent";
  if (stage === "branch_ready") return "prepare-branch";
  if (stage === "pr_created") return "create-pr";
  if (stage === "pr_merged") return "merge-pr";
  if (stage === "closed") return "closeout";
  return null;
}

function legacyRoleFromId(
  idValue: unknown,
  ownerId: unknown,
  scope: "task" | "delivery_unit",
): AtomicLifecycleRole | null {
  if (typeof idValue !== "string" || typeof ownerId !== "string") return null;
  const prefixes =
    scope === "task"
      ? [`task-atom-${ownerId}-`, `${ownerId}-`]
      : [`group-atom-${ownerId}-`, `${ownerId}-`];
  const ownerPrefix = prefixes.find((prefix) => idValue.startsWith(prefix));
  if (!ownerPrefix) return null;
  const suffix = idValue.slice(ownerPrefix.length);
  if (scope === "task" && suffix === "prepare-branch") return "prepare-branch";
  if (scope === "delivery_unit" && suffix === "prepare-parent") return "prepare-parent";
  if (suffix === "create-pr") return "create-pr";
  if (suffix === "merge-pr") return "merge-pr";
  if (suffix === "closeout") return "closeout";
  return null;
}

function lifecycleScopeOf(atom: {
  task_id?: unknown;
  group_id?: unknown;
  scope?: { kind?: unknown };
}): "task" | "delivery_unit" {
  return atom.scope?.kind === "task" || typeof atom.task_id === "string" ? "task" : "delivery_unit";
}

export function explicitLifecycleRoleOf(atom: {
  lifecycle_role?: unknown;
}): AtomicLifecycleRole | null {
  const explicit = atomicLifecycleRole.safeParse(atom.lifecycle_role);
  return explicit.success ? explicit.data : null;
}

/** Resolve only the bounded legacy stage/ID representation used by historical ledgers. */
export function inferredLifecycleRoleOf(atom: {
  id?: unknown;
  lifecycle_stage?: unknown;
  task_id?: unknown;
  group_id?: unknown;
  scope?: { kind?: unknown; task_id?: unknown; delivery_unit_id?: unknown };
}): AtomicLifecycleRole | null {
  const scope = lifecycleScopeOf(atom);
  const stage = lifecycleRoleFromStage(
    typeof atom.lifecycle_stage === "string"
      ? (atom.lifecycle_stage as LegacyLifecycleStage)
      : null,
    scope,
  );
  return (
    stage ??
    legacyRoleFromId(
      atom.id,
      scope === "task"
        ? (atom.scope?.task_id ?? atom.task_id)
        : (atom.scope?.delivery_unit_id ?? atom.group_id),
      scope,
    )
  );
}

export function lifecycleRoleOf(atom: {
  id?: unknown;
  lifecycle_role?: unknown;
  lifecycle_stage?: unknown;
  task_id?: unknown;
  group_id?: unknown;
  scope?: { kind?: unknown; task_id?: unknown; delivery_unit_id?: unknown };
}): AtomicLifecycleRole | null {
  return explicitLifecycleRoleOf(atom) ?? inferredLifecycleRoleOf(atom);
}

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
  .object({
    id,
    statement: text,
    evidence_kind: z.enum(["artifact", "provider_receipt", "quality", "online_verification"]),
  })
  .strict();
export const atomicRuntime = z
  .object({
    started_at: timestamp,
    updated_at: timestamp,
    evidence_refs: z.array(text).default([]),
  })
  .strict();
export const atomicResult = z
  .object({ completed_at: timestamp, evidence_refs: z.array(text).min(1) })
  .strict();

const workDefinition = z
  .object({
    kind: z.literal("work"),
    id,
    title: text,
    purpose: text,
    output: text,
    acceptance: z.array(atomicCriterion),
    lifecycle_role: atomicLifecycleRole.optional(),
  })
  .strict();
const workLifecycle = <T extends z.ZodTypeAny>(scope: T) =>
  z.discriminatedUnion("state", [
    z.object({ state: z.literal("design") }).strict(),
    z.object({ state: z.literal("planned"), scope }).strict(),
    z.object({ state: z.literal("starting"), scope, runtime: atomicRuntime }).strict(),
    z.object({ state: z.literal("running"), scope, runtime: atomicRuntime }).strict(),
    z
      .object({
        state: z.literal("blocked"),
        scope,
        runtime: atomicRuntime,
        blocker: atomicBlocker,
      })
      .strict(),
    z
      .object({
        state: z.literal("completed"),
        scope,
        runtime: atomicRuntime,
        result: atomicResult,
      })
      .strict(),
  ]);

export const atomicWorkNode = z.union([
  z.intersection(
    workDefinition.extend({ activity_type: z.enum(["contribution", "documentation"]) }),
    workLifecycle(atomicTaskScope),
  ),
  z.intersection(
    workDefinition.extend({ activity_type: z.enum(["verification", "release", "deployment"]) }),
    workLifecycle(atomicScope),
  ),
]);

export const milestoneCriterion = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node_satisfied"), node_id: id }).strict(),
  z.object({ kind: z.literal("pr_published"), pr_ref: atomicExternalRef }).strict(),
  z.object({ kind: z.literal("pr_merged"), pr_ref: atomicExternalRef, merge_sha: text }).strict(),
  z
    .object({
      kind: z.literal("ci_passed"),
      target_ref: text,
      head_sha: text,
      checks: z.array(text).min(1),
    })
    .strict(),
  z
    .object({ kind: z.literal("release_published"), release_id: text, artifact_digest: text })
    .strict(),
  z
    .object({ kind: z.literal("deployment_succeeded"), environment: text, artifact_digest: text })
    .strict(),
  z
    .object({ kind: z.literal("online_verification_passed"), target: text, verification_id: text })
    .strict(),
]);

export const milestoneNode = z.union([
  z
    .object({
      kind: z.literal("milestone"),
      id,
      title: text,
      state: z.literal("design"),
      acceptance: z.array(milestoneCriterion),
    })
    .strict(),
  z
    .object({
      kind: z.literal("milestone"),
      id,
      title: text,
      state: z.literal("planned"),
      scope: atomicScope,
      acceptance: z.array(milestoneCriterion),
    })
    .strict(),
]);

export const atomicBoundaryNode = z
  .object({
    kind: z.literal("boundary"),
    id,
    title: text,
    boundary: z.enum(["start", "end"]),
    state: z.enum(["planned", "completed"]),
  })
  .strict();

export const atomicNode = z.union([atomicWorkNode, milestoneNode, atomicBoundaryNode]);
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
  z.object({ state: z.literal("shared_delivery_unit"), delivery_unit_id: id }).strict(),
  z
    .object({ state: z.literal("open"), pr: atomicExternalRef, branch: text, base_branch: text })
    .strict(),
  z
    .object({ state: z.literal("merged"), pr: atomicExternalRef, branch: text, merge_sha: text })
    .strict(),
  z
    .object({
      state: z.literal("closed"),
      pr: atomicExternalRef,
      branch: text,
      closed_at: timestamp,
      closed_reason: z.enum(["abandoned", "superseded", "provider_closed", "replaced"]),
    })
    .strict(),
]);

export const deliveryUnitExternalFacts = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unpublished") }).strict(),
  z.object({ state: z.literal("published"), pr: atomicExternalRef, parent_branch: text }).strict(),
  z
    .object({
      state: z.literal("merged"),
      pr: atomicExternalRef,
      parent_branch: text,
      merge_sha: text,
    })
    .strict(),
  z
    .object({
      state: z.literal("closed"),
      pr: atomicExternalRef,
      parent_branch: text,
      closed_at: timestamp,
      closed_reason: z.enum(["abandoned", "superseded", "provider_closed", "replaced"]),
    })
    .strict(),
]);

export type AtomicNode = z.infer<typeof atomicNode>;
export type AtomicBoundaryNode = z.infer<typeof atomicBoundaryNode>;
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
  parent_pr_status?: "definitively_absent" | "unknown" | "pending" | "present";
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
  const scopedMilestones = nodes.filter(
    (node): node is Extract<AtomicNode, { kind: "milestone" }> => {
      if (node.kind !== "milestone" || !node.scope) return false;
      return scope.kind === "delivery_unit"
        ? node.scope.delivery_unit_id === scope.delivery_unit_id
        : node.scope.kind === "task" && node.scope.task_id === scope.task_id;
    },
  );
  if (!scoped.length && !scopedMilestones.length) return "planned";
  if (scoped.some((node) => node.kind === "work" && node.state === "blocked")) return "blocked";
  if (
    scopedMilestones.some((node) => {
      const evaluation = milestoneEvaluations.get(node.id);
      return evaluation?.status === "blocked";
    })
  )
    return "blocked";
  if (
    scoped.every((node) => node.kind === "work" && node.state === "completed") &&
    scopedMilestones.every((node) => milestoneEvaluations.get(node.id)?.status === "satisfied")
  )
    return "completed";
  if (
    scoped.some(
      (node) => node.kind === "work" && (node.state === "running" || node.state === "starting"),
    )
  )
    return "running";
  if (scoped.some((node) => node.kind === "work" && node.state === "planned")) return "ready";
  return "planned";
}

export function validateContributionStart(
  node: AtomicNode,
  deliveryUnit: { pr: DeliveryUnitExternalFacts; parent_branch?: string | null },
  context: ContributionStartContext = {},
): void {
  if (node.kind !== "work" || node.activity_type !== "contribution" || node.state !== "starting")
    return;
  const bootstrapException =
    context.delivery_unit_kind === "bootstrap" &&
    context.owner_kind === "main" &&
    context.execution_owner === "main" &&
    context.conversation_policy === "main_owned" &&
    context.active === true &&
    context.workspace_ready === true &&
    context.parent_pr_status === "definitively_absent" &&
    deliveryUnit.pr.state === "unpublished";
  if (
    !bootstrapException &&
    deliveryUnit.pr.state !== "published" &&
    deliveryUnit.pr.state !== "merged"
  )
    throw new Error("Contribution work requires a published DeliveryUnit PR before starting");
  if (!bootstrapException && !deliveryUnit.parent_branch)
    throw new Error("Contribution work requires a DeliveryUnit parent branch before starting");
}

export type MilestoneEvaluation =
  | { status: "pending"; unmet: string[]; evidence_refs: string[] }
  | { status: "satisfied"; evidence_refs: string[]; satisfied_at: string }
  | { status: "blocked"; blockers: z.infer<typeof atomicBlocker>[]; evidence_refs: string[] };

export function validateAtomicGraph(
  nodes: readonly AtomicNode[],
  edges: readonly AtomicEdge[],
): void {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error(`Duplicate atomic node: ${node.id}`);
    ids.add(node.id);
  }
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!ids.has(edge.from_node_id) || !ids.has(edge.to_node_id))
      throw new Error(`Atomic edge references missing node: ${edge.id}`);
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
      if (!incoming.length && !node.acceptance.length)
        throw new Error(`Planned milestone ${node.id} must have conditions`);
    }
  }
}

export function validateAtomicBoundaries(
  nodes: readonly AtomicNode[],
  edges: readonly AtomicEdge[],
): void {
  const starts = nodes.filter(
    (node): node is Extract<AtomicNode, { kind: "boundary" }> =>
      node.kind === "boundary" && node.boundary === "start",
  );
  const ends = nodes.filter(
    (node): node is Extract<AtomicNode, { kind: "boundary" }> =>
      node.kind === "boundary" && node.boundary === "end",
  );
  if (starts.length !== 1 || ends.length !== 1)
    throw new Error("Contract-3 atomic graph requires exactly one start and one end boundary");
  const incoming = new Set(edges.map((edge) => edge.to_node_id));
  const outgoing = new Set(edges.map((edge) => edge.from_node_id));
  if (incoming.has(starts[0]!.id) || outgoing.has(ends[0]!.id))
    throw new Error("Atomic start/end boundaries have invalid direction");
  const adjacency = new Map<string, string[]>();
  for (const edge of edges)
    adjacency.set(edge.from_node_id, [
      ...(adjacency.get(edge.from_node_id) ?? []),
      edge.to_node_id,
    ]);
  const reachable = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const visit = (node: string): boolean =>
      node === target ||
      (!seen.has(node) && (seen.add(node), (adjacency.get(node) ?? []).some(visit)));
    return visit(from);
  };
  for (const node of nodes) {
    if (!reachable(starts[0]!.id, node.id) || !reachable(node.id, ends[0]!.id))
      throw new Error(`Atomic node ${node.id} is outside the start/end path`);
  }
}

/**
 * Materialize the contract-3 atomic projection for a newly initialized plan.
 * Legacy atom definitions remain in the plan for compatibility, but they must
 * not be the only source used by the contract-3 viewer or scheduler.
 */
export function canonicalizeContract3Plan(
  rawPlan: any,
  tasks: readonly { id: string; kind?: string; group_id: string }[] = [],
): any {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const currentNodes: any[] = Array.isArray(rawPlan.atomic_nodes)
    ? rawPlan.atomic_nodes.map((node: any) => ({ ...node }))
    : [];
  const atomicNodes: any[] = currentNodes.length
    ? currentNodes
    : [
        ...(Array.isArray(rawPlan.atoms) ? rawPlan.atoms : []).map((atom: any) => {
          const task = taskById.get(atom.task_id);
          const activityType = ["verification", "release", "deployment"].includes(task?.kind ?? "")
            ? task?.kind
            : "contribution";
          const lifecycle_role = lifecycleRoleOf(atom);
          return {
            kind: "work",
            id: atom.id,
            title: atom.title,
            purpose: atom.purpose,
            output: atom.output,
            acceptance: [],
            activity_type: activityType,
            state: "planned",
            scope: {
              kind: "task",
              task_id: atom.task_id,
              delivery_unit_id: task?.group_id ?? "unassigned",
            },
            ...(lifecycle_role ? { lifecycle_role } : {}),
          };
        }),
        ...(Array.isArray(rawPlan.group_atoms) ? rawPlan.group_atoms : []).map((atom: any) => {
          const lifecycle_role = lifecycleRoleOf(atom);
          return {
            kind: "work",
            id: atom.id,
            title: atom.title,
            purpose: atom.purpose,
            output: atom.output,
            acceptance: [],
            activity_type: "verification",
            state: "planned",
            scope: { kind: "delivery_unit", delivery_unit_id: atom.group_id },
            ...(lifecycle_role ? { lifecycle_role } : {}),
          };
        }),
      ];
  if (currentNodes.length) {
    const expected = new Set([
      ...(rawPlan.atoms ?? []).map((atom: any) => atom.id),
      ...(rawPlan.group_atoms ?? []).map((atom: any) => atom.id),
    ]);
    const actual = new Set(atomicNodes.map((node: any) => node.id));
    for (const id of expected)
      if (!actual.has(id)) throw new Error(`Canonical atomic graph is missing node for atom ${id}`);
  }
  for (const node of atomicNodes) {
    if (node.kind !== "work" || node.lifecycle_role) continue;
    const legacy =
      (rawPlan.atoms ?? []).find((atom: any) => atom.id === node.id) ??
      (rawPlan.group_atoms ?? []).find((atom: any) => atom.id === node.id);
    const lifecycle_role = legacy ? lifecycleRoleOf(legacy) : lifecycleRoleOf(node);
    if (lifecycle_role) node.lifecycle_role = lifecycle_role;
  }
  const nodeIdForLegacyAtom = new Map<string, string>();
  for (const atom of rawPlan.atoms ?? []) {
    const matching =
      atomicNodes.find((node: any) => node.id === atom.id) ??
      (() => {
        const matches = atomicNodes.filter(
          (node: any) =>
            node.kind === "work" &&
            node.scope?.kind === "task" &&
            node.scope.task_id === atom.task_id,
        );
        return matches.length === 1 ? matches[0] : undefined;
      })();
    nodeIdForLegacyAtom.set(atom.id, matching?.id ?? atom.id);
    nodeIdForLegacyAtom.set(atom.task_id, matching?.id ?? atom.id);
  }
  for (const atom of rawPlan.group_atoms ?? []) {
    const matching = atomicNodes.find(
      (node: any) =>
        node.scope?.kind === "delivery_unit" &&
        node.scope.delivery_unit_id === atom.group_id &&
        node.id === atom.id,
    );
    nodeIdForLegacyAtom.set(atom.id, matching?.id ?? atom.id);
  }
  const declaredEdges = Array.isArray(rawPlan.atomic_edges) ? rawPlan.atomic_edges : [];
  // Contract 3 never infers atomic dependencies from the task/group graph.
  // The Agent must declare every atomic edge explicitly.
  const edgeCandidates = declaredEdges;
  const atomicEdges = edgeCandidates
    .filter((edge: any, index: number, all: any[]) => {
      const key = `${edge.from_node_id ?? edge.from_atom_id}->${edge.to_node_id ?? edge.to_atom_id}`;
      return (
        all.findIndex(
          (candidate: any) =>
            `${candidate.from_node_id ?? candidate.from_atom_id}->${candidate.to_node_id ?? candidate.to_atom_id}` ===
            key,
        ) === index
      );
    })
    .map((edge: any) => {
      if ("from_node_id" in edge)
        return {
          id: edge.id,
          from_node_id: nodeIdForLegacyAtom.get(edge.from_node_id) ?? edge.from_node_id,
          to_node_id: nodeIdForLegacyAtom.get(edge.to_node_id) ?? edge.to_node_id,
          requires:
            typeof edge.requires === "object"
              ? edge.requires
              : (() => {
                  throw new Error(
                    `Unsupported legacy atomic dependency condition: ${String(edge.requires)}`,
                  );
                })(),
        };
      return {
        id: edge.id,
        from_node_id: nodeIdForLegacyAtom.get(edge.from_atom_id) ?? edge.from_atom_id,
        to_node_id: nodeIdForLegacyAtom.get(edge.to_atom_id) ?? edge.to_atom_id,
        requires: { kind: "source_terminal_success" },
      };
    });
  return { ...rawPlan, atomic_nodes: atomicNodes, atomic_edges: atomicEdges };
}

const deliveryUnitLifecycleSuffixes = [
  "prepare-parent",
  "create-pr",
  "merge-pr",
  "closeout",
] as const;
const taskLifecycleSuffixes = ["prepare-branch", "create-pr", "merge-pr", "closeout"] as const;

export type LifecycleRoleValidationOptions = {
  /** Allow stage/owner-scoped ID fallback for contract-3/4/5 historical reads. */
  allowLegacyLifecycleRoleInference?: boolean;
};

function validatePresetLifecycleEdges(
  atoms: readonly any[],
  edges: readonly any[],
  suffixes: readonly string[],
  ownerLabel: string,
  ownerKey: "group_id" | "task_id",
  options: LifecycleRoleValidationOptions = { allowLegacyLifecycleRoleInference: true },
): void {
  const owners = new Map<string, any[]>();
  for (const atom of atoms) {
    const ownerId =
      atom[ownerKey] ??
      (ownerKey === "task_id" ? atom.scope?.task_id : atom.scope?.delivery_unit_id);
    if (typeof ownerId !== "string") continue;
    const explicitRole = explicitLifecycleRoleOf(atom);
    const inferredRole = inferredLifecycleRoleOf(atom);
    if (!options.allowLegacyLifecycleRoleInference && inferredRole && !explicitRole)
      throw new Error(
        `${ownerLabel} ${ownerId} lifecycle atom ${String(atom.id)} must declare lifecycle_role explicitly`,
      );
    if (
      !options.allowLegacyLifecycleRoleInference &&
      explicitRole &&
      inferredRole &&
      explicitRole !== inferredRole
    )
      throw new Error(
        `${ownerLabel} ${ownerId} lifecycle atom ${String(atom.id)} has conflicting lifecycle_role and legacy lifecycle identity`,
      );
    const role = options.allowLegacyLifecycleRoleInference
      ? (explicitRole ?? inferredRole)
      : explicitRole;
    if (
      role &&
      ((ownerKey === "task_id" && role === "prepare-parent") ||
        (ownerKey === "group_id" && role === "prepare-branch"))
    )
      throw new Error(`${ownerLabel} ${ownerId} has a lifecycle role from the wrong scope`);
    const list = owners.get(ownerId) ?? [];
    list.push({ ...atom, __lifecycle_role: role });
    owners.set(ownerId, list);
  }
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const from = edge.from_node_id ?? edge.from_atom_id;
    const to = edge.to_node_id ?? edge.to_atom_id;
    if (typeof from === "string" && typeof to === "string")
      outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
  }
  const reachable = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const visit = (node: string): boolean => {
      if (node === target) return true;
      if (seen.has(node)) return false;
      seen.add(node);
      return (outgoing.get(node) ?? []).some(visit);
    };
    return visit(from);
  };
  for (const [ownerId, ownerAtoms] of owners) {
    const bySuffix = new Map(
      suffixes.map((suffix) => [
        suffix,
        ownerAtoms.find((atom) => {
          const role = atom.__lifecycle_role as AtomicLifecycleRole | null;
          return role === suffix;
        }),
      ]),
    );
    if (!suffixes.some((suffix) => bySuffix.get(suffix))) continue;
    for (const suffix of suffixes)
      if (!bySuffix.get(suffix))
        throw new Error(`${ownerLabel} ${ownerId} has an incomplete preset lifecycle atom set`);
    for (let index = 1; index < suffixes.length; index++) {
      const from = bySuffix.get(suffixes[index - 1])!.id;
      const to = bySuffix.get(suffixes[index])!.id;
      if (!reachable(from, to))
        throw new Error(
          `${ownerLabel} ${ownerId} lifecycle requires an Agent-declared dependency path from ${from} to ${to}`,
        );
    }
  }
}

/** Require Agent-declared delivery-unit lifecycle ordering without inventing edges. */
export function validateDeliveryUnitLifecycleEdges(
  groupAtoms: readonly any[],
  edges: readonly any[],
  options: LifecycleRoleValidationOptions = { allowLegacyLifecycleRoleInference: true },
): void {
  validatePresetLifecycleEdges(
    groupAtoms,
    edges,
    deliveryUnitLifecycleSuffixes,
    "Delivery unit",
    "group_id",
    options,
  );
}

/** Require Agent-declared task lifecycle ordering without inferring edges from atom names. */
export function validateTaskLifecycleEdges(
  taskAtoms: readonly any[],
  edges: readonly any[],
  options: LifecycleRoleValidationOptions = { allowLegacyLifecycleRoleInference: true },
): void {
  validatePresetLifecycleEdges(taskAtoms, edges, taskLifecycleSuffixes, "Task", "task_id", options);
}

/** Materialize the canonical graph for a contract-3 ledger without inventing
 * runtime facts. This is safe for maintenance because it only derives nodes
 * and edges from the already persisted plan atoms. */
export function canonicalizeContract3Ledger(raw: any): any {
  const candidate = structuredClone(raw);
  const tasks = Array.isArray(candidate.tasks) ? candidate.tasks : [];
  candidate.plans = Array.isArray(candidate.plans)
    ? candidate.plans.map((item: any) => canonicalizeContract3Plan(item, tasks))
    : [];
  const activePlanId = candidate.execution_plan_id ?? candidate.active_plan_id;
  const activePlan =
    candidate.plans.find((item: any) => item.id === activePlanId) ?? candidate.plans[0];
  if (activePlan) {
    candidate.atomic_nodes =
      Array.isArray(candidate.atomic_nodes) && candidate.atomic_nodes.length
        ? candidate.atomic_nodes
        : activePlan.atomic_nodes;
    candidate.atomic_edges =
      Array.isArray(candidate.atomic_edges) &&
      candidate.atomic_edges.some((edge: any) => "from_node_id" in edge)
        ? candidate.atomic_edges
        : activePlan.atomic_edges;
  }
  return candidate;
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
  if (conditions.some((condition) => condition.blocked))
    return {
      status: "blocked",
      blockers: [
        {
          code: "MILESTONE_CONDITION_FAILED",
          message: `Milestone ${node.id} has a failed condition`,
          evidence_refs,
        },
      ],
      evidence_refs,
    };
  if (conditions.every((condition) => condition.satisfied))
    return { status: "satisfied", evidence_refs, satisfied_at: now };
  return {
    status: "pending",
    unmet: conditions
      .map((_, index) => String(index))
      .filter((_, index) => !conditions[index]!.satisfied),
    evidence_refs,
  };
}

export function migrateLegacyTaskAtoms(raw: any): any[] {
  const groups = Array.isArray(raw?.groups) ? raw.groups : [];
  if (groups.some((group: any) => Array.isArray(group?.atoms) && group.atoms.length))
    throw new Error(
      "Legacy Group.atoms has ambiguous semantics; explicit plan revision is required",
    );
  const tasks = Array.isArray(raw?.tasks) ? raw.tasks : [];
  return tasks.flatMap((task: any) =>
    (Array.isArray(task?.atoms) ? task.atoms : []).map((atom: any) => {
      const state =
        atom.status === "completed"
          ? "completed"
          : atom.status === "blocked"
            ? "blocked"
            : atom.status === "running"
              ? "running"
              : "planned";
      const scope = { kind: "task", task_id: task.id, delivery_unit_id: task.group_id };
      if (state === "planned")
        return {
          kind: "work",
          id: atom.id,
          title: atom.title,
          purpose: atom.title,
          output: atom.title,
          acceptance: [],
          activity_type: "contribution",
          state,
          scope,
        };
      const runtime = {
        started_at: task.started_at ?? new Date(0).toISOString(),
        updated_at: task.finished_at ?? task.started_at ?? new Date(0).toISOString(),
        evidence_refs: [],
      };
      if (state === "completed")
        return {
          kind: "work",
          id: atom.id,
          title: atom.title,
          purpose: atom.title,
          output: atom.title,
          acceptance: [],
          activity_type: "contribution",
          state,
          scope,
          runtime,
          result: {
            completed_at: task.finished_at ?? runtime.updated_at,
            evidence_refs: ["legacy:task:" + task.id],
          },
        };
      if (state === "blocked")
        return {
          kind: "work",
          id: atom.id,
          title: atom.title,
          purpose: atom.title,
          output: atom.title,
          acceptance: [],
          activity_type: "contribution",
          state,
          scope,
          runtime,
          blocker: {
            code: "LEGACY_BLOCKED",
            message: task.blocker ?? "Legacy task was blocked",
            evidence_refs: [],
          },
        };
      return {
        kind: "work",
        id: atom.id,
        title: atom.title,
        purpose: atom.title,
        output: atom.title,
        acceptance: [],
        activity_type: "contribution",
        state,
        scope,
        runtime,
      };
    }),
  );
}

export function contract3MigrationCandidate(raw: any): any {
  const candidate = structuredClone(raw);
  const legacyNodes = migrateLegacyTaskAtoms(raw);
  const selectedPlanId = raw?.execution_plan_id ?? raw?.active_plan_id;
  const selectedPlan = Array.isArray(raw?.plans)
    ? (raw.plans.find((plan: any) => plan.id === selectedPlanId) ??
      raw.plans.find((plan: any) => plan.lifecycle === "approved") ??
      raw.plans[0])
    : null;
  const legacyEdges = Array.isArray(selectedPlan?.atomic_edges) ? selectedPlan.atomic_edges : [];
  const canonicalEdges = legacyEdges
    .filter(
      (edge: any) =>
        edge && typeof edge.from_atom_id === "string" && typeof edge.to_atom_id === "string",
    )
    .map((edge: any) => ({
      id: edge.id,
      from_node_id: edge.from_atom_id,
      to_node_id: edge.to_atom_id,
      requires: { kind: "source_terminal_success" },
    }));
  candidate.contract_version = 3;
  candidate.groups = Array.isArray(candidate.groups)
    ? candidate.groups.map((group: any) => {
        if (group.parent_pr) {
          const state =
            group.state === "merged" ? "merged" : group.state === "closed" ? "closed" : "published";
          return {
            ...group,
            pr:
              state === "merged"
                ? {
                    state,
                    pr: group.parent_pr,
                    parent_branch: group.parent_branch ?? "main",
                    merge_sha: group.merge_sha ?? "0000000000000000000000000000000000000000",
                  }
                : state === "closed"
                  ? {
                      state,
                      pr: group.parent_pr,
                      parent_branch: group.parent_branch ?? "main",
                      closed_at: group.finished_at ?? new Date(0).toISOString(),
                      closed_reason: "provider_closed",
                    }
                  : { state, pr: group.parent_pr, parent_branch: group.parent_branch ?? "main" },
          };
        }
        if (group.pr && typeof group.pr.state === "string") return group;
        return { ...group, pr: { state: "unpublished" } };
      })
    : candidate.groups;
  candidate.tasks = Array.isArray(candidate.tasks)
    ? candidate.tasks.map((task: any) => {
        if (task.pr && typeof task.pr.state === "string") return task;
        if (task.pr && task.branch && task.base_branch) {
          const state =
            task.state === "integrated" || task.state === "completed"
              ? "merged"
              : task.state === "closed"
                ? "closed"
                : "open";
          return {
            ...task,
            pr:
              state === "merged"
                ? {
                    state,
                    pr: task.pr,
                    branch: task.branch,
                    merge_sha: task.merge_sha ?? "0000000000000000000000000000000000000000",
                  }
                : state === "closed"
                  ? {
                      state,
                      pr: task.pr,
                      branch: task.branch,
                      closed_at: task.finished_at ?? new Date(0).toISOString(),
                      closed_reason: "provider_closed",
                    }
                  : { state, pr: task.pr, branch: task.branch, base_branch: task.base_branch },
          };
        }
        return { ...task, pr: { state: "unbound" } };
      })
    : candidate.tasks;
  candidate.atomic_nodes =
    Array.isArray(raw?.atomic_nodes) && raw.atomic_nodes.length ? raw.atomic_nodes : legacyNodes;
  candidate.atomic_edges =
    Array.isArray(raw?.atomic_edges) && raw.atomic_edges.length ? raw.atomic_edges : canonicalEdges;
  return canonicalizeContract3Ledger(candidate);
}
