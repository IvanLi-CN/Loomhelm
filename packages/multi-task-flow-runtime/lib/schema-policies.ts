import { z } from "zod";
import { requireCondition } from "../lib/errors";
import type {
  executionPhase,
  executionProfile,
  planHandoffSource,
  planRevision,
  Task,
} from "./schema-models";

export const TASK_EXECUTION_POLICY_FIELDS = [
  "execution_owner",
  "conversation_policy",
  "delivery_policy",
] as const;
const taskExecutionPolicyDeclaration = z
  .object({
    execution_owner: z.enum(["main", "delivery_agent", "task_agent"]).nullable(),
    conversation_policy: z.enum(["main_owned", "delivery_owned", "task_agent", "none"]).nullable(),
    delivery_policy: z
      .enum(["parent_pr", "child_pr", "shared_delivery_unit", "evidence", "none"])
      .nullable(),
  })
  .strict();
export type TaskExecutionPolicyField = (typeof TASK_EXECUTION_POLICY_FIELDS)[number];
export type TaskExecutionPolicyDeclarationGap = {
  task_id: string;
  missing_fields: TaskExecutionPolicyField[];
};

export function taskExecutionPolicyDeclarationGaps(
  value: unknown,
): TaskExecutionPolicyDeclarationGap[] {
  const candidate = value as { tasks?: unknown } | null;
  if (!candidate || !Array.isArray(candidate.tasks)) return [];
  return candidate.tasks.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const task = item as Record<string, unknown>;
    const missing_fields = TASK_EXECUTION_POLICY_FIELDS.filter(
      (field) => !Object.hasOwn(task, field),
    );
    return missing_fields.length
      ? [
          {
            task_id: typeof task.id === "string" ? task.id : `task-${index}`,
            missing_fields,
          },
        ]
      : [];
  });
}

export type TaskExecutionPolicyIssue = { code: string; message: string };

export function taskExecutionPolicyIssues(
  candidate: Pick<Task, "execution_owner" | "conversation_policy" | "delivery_policy">,
): TaskExecutionPolicyIssue[] {
  const {
    execution_owner: owner,
    conversation_policy: conversation,
    delivery_policy: delivery,
  } = candidate;
  if (owner === null && conversation === null && delivery === null) return [];
  const issues: TaskExecutionPolicyIssue[] = [];
  if (owner === null || conversation === null || delivery === null) {
    issues.push({
      code: "TASK_EXECUTION_POLICY_INCOMPLETE",
      message: "任务执行归属、对话策略和交付策略必须同时声明",
    });
    return issues;
  }
  if (owner === "main" && conversation !== "main_owned")
    issues.push({
      code: "TASK_EXECUTION_POLICY_CONFLICT",
      message: "Main Agent 任务必须使用 main_owned 对话策略",
    });
  if (owner === "task_agent" && conversation !== "task_agent")
    issues.push({
      code: "TASK_EXECUTION_POLICY_CONFLICT",
      message: "Task Agent 任务必须使用 task_agent 对话策略",
    });
  if (owner === "delivery_agent" && conversation !== "delivery_owned")
    issues.push({
      code: "TASK_EXECUTION_POLICY_CONFLICT",
      message: "交付 Agent 任务必须使用 delivery_owned 对话策略",
    });
  if (owner === "main" && delivery === "child_pr")
    issues.push({
      code: "TASK_EXECUTION_POLICY_CONFLICT",
      message: "Main Agent 不得拥有 child PR",
    });
  if (owner === "delivery_agent" && delivery === "child_pr")
    issues.push({
      code: "TASK_EXECUTION_POLICY_CONFLICT",
      message: "交付 Agent 不得拥有 child PR",
    });
  if (owner === "task_agent" && delivery === "parent_pr")
    issues.push({
      code: "TASK_EXECUTION_POLICY_CONFLICT",
      message: "Task Agent 不得拥有 parent PR",
    });
  if (delivery === "shared_delivery_unit" && owner !== "delivery_agent")
    issues.push({
      code: "TASK_EXECUTION_POLICY_CONFLICT",
      message: "共享交付任务必须由交付 Agent 持有",
    });
  if (delivery === "shared_delivery_unit" && conversation !== "delivery_owned")
    issues.push({
      code: "TASK_EXECUTION_POLICY_CONFLICT",
      message: "共享交付任务必须复用交付单元对话",
    });
  if (conversation === "none" && ["child_pr", "evidence"].includes(delivery))
    issues.push({
      code: "TASK_EXECUTION_POLICY_CONFLICT",
      message: "无对话任务不能声明 child PR 或验证证据",
    });
  return issues;
}

export function validateTaskExecutionPolicies(
  tasks: readonly Task[],
  requireComplete = false,
): void {
  for (const candidate of tasks) {
    const parsed = taskExecutionPolicyDeclaration.safeParse({
      execution_owner: candidate.execution_owner,
      conversation_policy: candidate.conversation_policy,
      delivery_policy: candidate.delivery_policy,
    });
    requireCondition(
      parsed.success,
      "TASK_EXECUTION_POLICY_INVALID",
      `${candidate.id}: 任务执行策略值无效`,
      3,
    );
    if (
      requireComplete &&
      parsed.data.execution_owner === null &&
      parsed.data.conversation_policy === null &&
      parsed.data.delivery_policy === null
    )
      requireCondition(
        false,
        "TASK_EXECUTION_POLICY_INCOMPLETE",
        `${candidate.id}: 任务执行归属、对话策略和交付策略必须声明`,
        3,
      );
    const issues = taskExecutionPolicyIssues(parsed.data);
    requireCondition(
      issues.length === 0,
      issues[0]?.code ?? "TASK_EXECUTION_POLICY_INVALID",
      `${candidate.id}: ${issues.map((issue) => issue.message).join("；")}`,
      3,
    );
  }
}
export function isContributionKind(kind: Task["kind"]): boolean {
  return kind === "contribution" || kind === "development";
}

export type DeliveryTopology = "shared_delivery" | "multi_task_integration" | "none";

export function deliveryTopologyForGroup(
  tasks: readonly Pick<Task, "group_id" | "kind" | "disposition">[],
  groupId: string,
): DeliveryTopology {
  const count = tasks.filter(
    (task) =>
      task.group_id === groupId && task.disposition === "active" && isContributionKind(task.kind),
  ).length;
  return count === 0 ? "none" : count === 1 ? "shared_delivery" : "multi_task_integration";
}

/**
 * Validate the execution policy derived from the main Agent's approved grouping.
 * The grouping itself is a planning decision; this function only checks that the
 * resulting one-task/multi-task topology is represented consistently at runtime.
 */
export function validateDeliveryTopologies(tasks: readonly Task[], requireComplete = false): void {
  const groupIds = new Set(
    tasks
      .filter((task) => task.disposition === "active" && isContributionKind(task.kind))
      .map((task) => task.group_id),
  );
  for (const groupId of groupIds) {
    const topology = deliveryTopologyForGroup(tasks, groupId);
    const contributionTasks = tasks.filter(
      (task) =>
        task.group_id === groupId && task.disposition === "active" && isContributionKind(task.kind),
    );
    if (!requireComplete) {
      if (contributionTasks.some((task) => task.delivery_policy === "shared_delivery_unit"))
        requireCondition(
          topology === "shared_delivery",
          "DELIVERY_TOPOLOGY_CONFLICT",
          `Delivery unit ${groupId} can use shared delivery only with one contribution task`,
          3,
        );
      continue;
    }
    for (const task of contributionTasks) {
      if (topology === "shared_delivery") {
        requireCondition(
          task.execution_owner === "delivery_agent" &&
            task.conversation_policy === "delivery_owned" &&
            task.delivery_policy === "shared_delivery_unit",
          "DELIVERY_TOPOLOGY_CONFLICT",
          `Task ${task.id} must use the delivery-unit conversation and shared PR topology`,
          3,
        );
      } else {
        requireCondition(
          task.execution_owner === "task_agent" &&
            task.conversation_policy === "task_agent" &&
            task.delivery_policy === "child_pr",
          "DELIVERY_TOPOLOGY_CONFLICT",
          `Task ${task.id} must use an independent Task Agent and child PR in a multi-task delivery unit`,
          3,
        );
      }
    }
  }
}

export function isCanonicalTaskKind(kind: Task["kind"]): boolean {
  return ["contribution", "release", "deployment", "verification"].includes(kind);
}
export function validateNewTaskKinds(tasks: Task[]): void {
  for (const item of tasks)
    requireCondition(
      isCanonicalTaskKind(item.kind),
      "INVALID_TASK_KIND",
      `New task ${item.id} uses retired task kind ${item.kind}; coordination must be represented by delivery-unit coordination state`,
      3,
    );
}
export type PlanRevision = z.infer<typeof planRevision>;
export type ExecutionPhase = z.infer<typeof executionPhase>;
export type ExecutionProfile = z.infer<typeof executionProfile>;
export const DEFAULT_EXECUTION_PROFILE: ExecutionProfile = {
  model: "gpt-5.6-luna",
  thinking: "max",
};
export function recommendedExecutionProfile(
  kind: Task["kind"],
  fallback: ExecutionProfile,
): ExecutionProfile {
  if (["development", "contribution"].includes(kind))
    return { model: "gpt-6.1-sol", thinking: "high" };
  if (["verification", "release", "deployment"].includes(kind))
    return { model: "gpt-6-luna", thinking: "medium" };
  return { ...fallback };
}
export type DevPlanHandoffSource = z.infer<typeof planHandoffSource>;
