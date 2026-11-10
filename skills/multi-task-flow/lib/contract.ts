import { z } from "zod";
import { deriveExecutionPhase } from "../lib/revisions";
import { ledgerSchema, type Ledger, type PlanRevision } from "../lib/schema";

export const CONTRACT_VERSION = 2 as const;
export const SKILL_ID = "multi-task-flow" as const;
export const SKILL_VERSION = "2.7.0" as const;
export const VIEWER_CONTRACT = 3 as const;
export const versionEnvelope = { skill_id: SKILL_ID, skill_version: SKILL_VERSION, viewer_contract: VIEWER_CONTRACT } as const;

export const contractMetadata = {
  schema_version: {
    term: "schema_version",
    description: "账本存储结构版本；结构迁移与领域语义版本分开管理。",
    forbiddenInterpretation: "结构版本相同不代表状态语义和迁移规则相同。",
  },
  contract_version: {
    term: "contract_version",
    description: "领域语义版本；状态含义、必填约束或迁移规则改变时递增。",
    forbiddenInterpretation: "不能用 schema_version 代替语义版本。",
  },
  execution_phase: {
    term: "execution_phase",
    description:
      "编排当前所处阶段；首个真实 task_started 事实前为 planning，之后单调为 implementation。",
    values: {
      planning: "尚无任务产生真实开始事实。",
      implementation: "至少一个任务已经产生真实 task_started 事实。",
    },
    forbiddenInterpretation:
      "dispatch claim、starting 或计划选择不代表 implementation。",
  },
  plan_lifecycle: {
    term: "plan_lifecycle",
    description: "单个计划版本的生命周期，与 execution_phase 独立。",
    values: {
      proposed: "已提出但尚未获批准。",
      approved: "可作为执行计划使用。",
      superseded: "已被批准的新版本替代。",
      abandoned: "被明确放弃，不再作为候选。",
    },
  },
  active_plan_id: {
    term: "active_plan_id",
    description: "当前选择的计划版本，可指向尚未批准的候选版本。",
    forbiddenInterpretation: "不代表该版本已批准或正在支配运行。",
  },
  execution_plan_id: {
    term: "execution_plan_id",
    description: "当前实际支配任务调度和运行事实的已批准计划版本。",
    forbiddenInterpretation: "不能由 active_plan_id 单独推导。",
  },
  change_class: {
    term: "change_class",
    description:
      "由 runtime 根据规范化 diff 和 execution_phase 推导的修订类别。",
    values: {
      planning_revision: "设计阶段修订；理由可选，diff 和重新批准必需。",
      implementation_low_impact:
        "实现阶段低影响修订；理由必需，不暂停且不重新批准。",
      implementation_high_impact:
        "实现阶段高影响修订；理由、证据、新版本和重新批准必需。",
    },
    forbiddenInterpretation: "调用方不能自报较低风险类别。",
  },
  disposition: {
    term: "disposition",
    description: "任务责任身份的处置状态，与 task.state 的执行状态分开。",
    values: {
      active: "任务仍是当前责任对象。",
      superseded: "任务被迁移到新任务身份。",
      abandoned: "任务被明确放弃。",
    },
  },
  superseded_by_task_id: {
    term: "superseded_by_task_id",
    description:
      "替代旧任务责任身份的新任务 ID；旧任务处置为 superseded 时必须存在。",
    forbiddenInterpretation: "不是旧任务事实的删除标记，也不是运行状态回滚。",
  },
  change_set: {
    term: "change_set",
    description:
      "由 runtime 生成的规范化计划 diff，按 added、removed、modified 保留路径和旧/新值。",
    forbiddenInterpretation:
      "不能由调用方只提交摘要或省略空集合来代替 canonical diff。",
  },
  plan_revision: {
    term: "plan_revision",
    description:
      "绑定阶段、变更级别、影响对象、diff、理由、批准要求和暂停对象的不可变审计记录。",
    forbiddenInterpretation:
      "不是可直接覆盖计划内容的补丁，也不是 UI 筛选状态。",
  },
  paused_task_ids: {
    term: "paused_task_ids",
    description:
      "待批准高影响候选修订期间不可 ready 的受影响任务及其后继；批准后仅作为历史审计信息保留。",
    forbiddenInterpretation: "批准后的历史列表不能继续被当作运行时 hold。",
  },
} as const;

export function contractJsonSchema(): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(ledgerSchema) as Record<string, unknown>),
    "x-contract-version": CONTRACT_VERSION,
    "x-field-metadata": Object.fromEntries(
      Object.entries(contractMetadata).map(([field, metadata]) => [
        field,
        { ...metadata, contract_version: CONTRACT_VERSION },
      ]),
    ),
  };
}
export function localSemanticProjection(
  ledger: Ledger,
  operation = "inspect",
  revision: PlanRevision | null = null,
): Record<string, unknown> {
  const active = ledger.plans.find(
    (plan) => plan.id === ledger.active_plan_id,
  )!;
  const executing = ledger.plans.find(
    (plan) => plan.id === ledger.execution_plan_id,
  )!;
  const effectiveRevision = revision ?? active.revision;
  return {
    contract_version: ledger.contract_version,
    operation,
    field_metadata: Object.fromEntries(
      Object.entries(contractMetadata)
        .filter(([field]) =>
          [
            "schema_version",
            "contract_version",
            "execution_phase",
            "plan_lifecycle",
            "active_plan_id",
            "execution_plan_id",
            "change_class",
            "disposition",
            "superseded_by_task_id",
            "change_set",
            "plan_revision",
            "paused_task_ids",
          ].includes(field),
        )
        .map(([field, metadata]) => [
          field,
          { ...metadata, contract_version: ledger.contract_version },
        ]),
    ),
    phase: {
      field: "execution_phase",
      value: deriveExecutionPhase(ledger),
      meaning: contractMetadata.execution_phase.description,
    },
    plans: {
      active_plan_id: ledger.active_plan_id,
      active_lifecycle: active.lifecycle,
      execution_plan_id: ledger.execution_plan_id,
      execution_lifecycle: executing.lifecycle,
      approval_pending:
        active.id !== executing.id && active.lifecycle === "proposed",
    },
    revision: effectiveRevision
      ? {
          change_class: effectiveRevision.change_class,
          affected_task_ids: effectiveRevision.affected_task_ids,
          affected_node_ids: effectiveRevision.affected_node_ids,
          affected_edge_ids: effectiveRevision.affected_edge_ids,
          approval_required: effectiveRevision.approval_required,
          paused_task_ids: effectiveRevision.paused_task_ids,
          reason_required:
            effectiveRevision.change_class !== "planning_revision",
          evidence_required:
            effectiveRevision.change_class === "implementation_high_impact",
          diff: effectiveRevision.change_set,
        }
      : null,
    transitions: [
      "planning -> implementation only after task_started",
      "proposed -> approved only through owner approval",
      "approved -> superseded only when a replacement is approved",
      "started task identity cannot be rewritten; migrate to a new task ID",
    ],
    examples: {
      positive: [
        "A dependency deletion before task_started is planning_revision with an auditable diff and optional reason.",
        "A dependency deletion after task_started is implementation_high_impact and pauses affected successors.",
      ],
      negative: [
        "active_plan_id alone is not execution completion.",
        "A provider or dispatch observation cannot self-declare checks or approval.",
      ],
    },
  };
}
