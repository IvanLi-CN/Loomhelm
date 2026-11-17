import { normalizeRetiredPlanAlias } from "../lib/legacy-plan-alias";

export function normalizeLegacyLedger(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  const rawPlans = Array.isArray(raw.plans) ? raw.plans : [];
  const plans = rawPlans.map((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
      return candidate;
    const item = normalizeRetiredPlanAlias(candidate as Record<string, unknown>);
    if (
      item.plan_handoff !== null &&
      typeof item.plan_handoff === "object" &&
      !Array.isArray(item.plan_handoff) &&
      Object.keys(item.plan_handoff as Record<string, unknown>).length === 0
    ) {
      const { plan_handoff: _legacyHandoff, ...withoutLegacyHandoff } = item;
      return {
        ...withoutLegacyHandoff,
        lifecycle: item.lifecycle ?? (item.approval_id === null ? "proposed" : "approved"),
        revision: item.revision ?? null,
      };
    }
    return {
      ...item,
      lifecycle: item.lifecycle ?? (item.approval_id === null ? "proposed" : "approved"),
      revision: item.revision ?? null,
    };
  });
  return {
    ...raw,
    schema_version: 2,
    source_schema_version: raw.schema_version === 1 ? 1 : (raw.source_schema_version ?? null),
    contract_version:
      raw.schema_version === undefined || raw.schema_version === 1
        ? 1
        : raw.contract_version === 4
          ? 4
          : raw.contract_version === 3
            ? 3
            : raw.contract_version === 2
              ? 2
              : 1,
    execution_plan_id: raw.execution_plan_id ?? raw.active_plan_id,
    milestones: Array.isArray(raw.milestones) ? raw.milestones : [],
    atomic_nodes: Array.isArray(raw.atomic_nodes) ? raw.atomic_nodes : [],
    atomic_edges: Array.isArray(raw.atomic_edges) ? raw.atomic_edges : [],
    groups: Array.isArray(raw.groups)
      ? raw.groups.map((item) =>
          item && typeof item === "object"
            ? {
                lifecycle: {
                  workspace_ready: "unknown",
                  pr_created: "unknown",
                  pr_merged: "unknown",
                  closed: "unknown",
                  ...((item as any).lifecycle ?? {}),
                },
                atoms: Array.isArray((item as any).atoms) ? (item as any).atoms : [],
                coordination_execution: (item as any).coordination_execution ?? {
                  state: "unknown",
                  reason: null,
                  waiting_for_task_ids: [],
                },
                delivery_unit_kind: "regular",
                owner_kind: "group",
                ...(item as any),
              }
            : item,
        )
      : raw.groups,
    tasks: Array.isArray(raw.tasks)
      ? raw.tasks.map((item) =>
          item && typeof item === "object"
            ? {
                branch: null,
                lifecycle: {
                  workspace_ready: "unknown",
                  pr_created: "unknown",
                  pr_merged: "unknown",
                  closed: "unknown",
                  ...((item as any).lifecycle ?? {}),
                },
                ...(item as any),
              }
            : item,
        )
      : raw.tasks,
    notifications: Array.isArray(raw.notifications)
      ? raw.notifications.map((item) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? {
                ledger_status: "committed",
                delivery_status:
                  (item as any).delivery_status ??
                  ((item as any).status === "acknowledged"
                    ? "sent"
                    : ((item as any).status ?? "pending")),
                ack_status:
                  (item as any).ack_status ??
                  ((item as any).status === "acknowledged" ? "acknowledged" : "unacknowledged"),
                last_attempt_id: null,
                last_reconciliation_id: null,
                last_error: null,
                ...(item as any),
              }
            : item,
        )
      : raw.notifications,
    plans: plans.map((item: any) => ({
      group_atoms: Array.isArray(item.group_atoms) ? item.group_atoms : [],
      ...item,
    })),
  };
}
