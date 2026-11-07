import type { AgentOutput } from "./agent-output";
export type AtomicTask = {
  id: string;
  title: string;
  status: "planned" | "running" | "completed" | "blocked";
  completed_at?: string | null;
  purpose?: string;
  output?: string;
};

export type GroupAtom = AtomicTask & {
  purpose: string;
  output: string;
  lifecycle_stage: "workspace_ready" | "pr_created" | "pr_merged" | "closed" | null;
};

export type CoordinationExecution = {
  state: "unknown" | "idle" | "running" | "waiting" | "blocked";
  reason: string | null;
  waiting_for_task_ids: string[];
};

export type Task = {
  id: string;
  title: string;
  kind: string;
  group_id: string;
  thread_id: string | null;
  state: string;
  is_ready: boolean;
  disposition?: string;
  superseded_by_task_id?: string | null;
  is_held?: boolean;
  hold_reason?: string | null;
  latest_output?: string | null;
  latest_agent_output?: AgentOutput;
  agent_idle?: boolean;
  conversation_resource?: {
    id: string;
    kind: "conversation";
    target: string | null;
    status: "unknown" | "active" | "pending" | "closed" | "archive_failed" | "archive_unknown" | "not_applicable";
    evidence_ref: string | null;
    error?: string | null;
    last_attempt_at?: string | null;
    operation_id?: string | null;
  } | null;
  pr: { url: string | null } | null;
  requirements_path: string | null;
  started_at: string | null;
  finished_at: string | null;
  blocker: string | null;
  atoms?: AtomicTask[];
  planned_atoms?: AtomicTask[];
  execution_profile?: { model: string; thinking: string } | null;
  effective_execution_profile?: { model: string; thinking: string } | null;
  profile_freeze_reason?: string | null;
  execution_profile_source?: string | null;
  execution_profile_rule?: string | null;
};

export type Group = {
  id: string;
  title: string;
  delivery_unit_kind?: "bootstrap" | "regular";
  owner_kind?: "main" | "group";
  agent_thread_id: string | null;
  state: string;
  parent_pr: { url: string | null } | null;
  requirements_path: string | null;
  atoms?: GroupAtom[];
  planned_atoms?: GroupAtom[];
  lifecycle?: Partial<Record<GroupAtom["lifecycle_stage"] & string, string>>;
  lifecycle_completed_at?: Partial<Record<GroupAtom["lifecycle_stage"] & string, string | null>>;
  coordination_execution?: CoordinationExecution;
  execution_profile?: { model: string; thinking: string } | null;
  effective_execution_profile?: { model: string; thinking: string } | null;
  profile_freeze_reason?: string | null;
  execution_profile_source?: string | null;
  execution_profile_rule?: string | null;
};

export type Node = {
  id: string;
  kind: string;
  ref_id: string | null;
  group_id: string | null;
  planned_group_id: string | null;
  label: string;
};

export type Edge = {
  id: string;
  from_node_id: string;
  to_node_id: string;
  requires: string;
};

export type View = {
  profile_read_only?: boolean;
  orchestration: {
    id: string;
    owner_thread_id?: string | null;
    repository: { owner: string; name: string; host: string };
    revision: number;
    updated_at: string;
    display_timezone: string;
    max_running_tasks: number;
    conversation_links_verified: boolean;
    contract_version?: number;
    execution_profile?: { model: string; thinking: string } | null;
  };
  groups: Group[];
  tasks: Task[];
  execution_phase?: "planning" | "implementation";
  active_plan_id?: string;
  execution_plan_id?: string;
  plan_state?: {
    active_plan_id: string;
    execution_plan_id: string;
    lifecycle: string;
    approval_pending: boolean;
    revision?: {
      change_class: string;
      approval_required: boolean;
      reason: { category: string; summary: string; evidence_refs: string[] } | null;
      change_set: { added: { path: string }[]; removed: { path: string }[]; modified: { path: string }[] };
      paused_task_ids: string[];
    } | null;
  };
  plans: { id: string; created_at: string; approval_id?: string | null; lifecycle?: string; is_active?: boolean; is_execution?: boolean; change_class?: string | null }[];
  selected_plan_id: string;
  follow_prs: { origin_task_id: string; origin_group_id: string; state: string; pr: { url: string | null } }[];
  nodes: Node[];
  edges: Edge[];
  atomic_edges?: { id: string; from_atom_id: string; to_atom_id: string }[];
  planned_intervals: { node_id: string; start: string | null; end: string | null }[];
  actual_intervals: { task_id: string; group_id: string; state: string; start: string; end: string | null }[];
  actual_milestones: { node_id: string; occurred_at: string | null }[];
  plan_warnings?: { code: string; reason: string }[];
  warnings: { reason: string }[];
};

export type ViewResponse = {
  output_epoch?: string; output_revision?: number;
  revision: number;
  watching: boolean;
  active_plan_id: string;
  execution_plan_id?: string;
  view: View;
};

export type Theme = "system" | "light" | "dark";

export type ConnectionStatus = "live" | "stale" | "connecting";

export function deriveConnectionStatus(connected: boolean, watching: boolean): ConnectionStatus {
  if (!watching) return "stale";
  return connected ? "live" : "connecting";
}
