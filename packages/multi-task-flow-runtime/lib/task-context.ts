import { taskDispatchEligibility } from "./dispatch-eligibility";
import { ready } from "./engine-support-gates";
import type { Ledger, Task } from "./schema";

export function taskContext(
  ledger: Ledger,
  taskId: string | undefined,
  contextTask: Task | undefined,
) {
  const contextPlan = ledger.plans.find((item) => item.id === ledger.execution_plan_id);
  const contextNode = contextPlan?.nodes.find(
    (item) => item.kind === "task" && item.ref_id === taskId,
  );
  const contextEdges =
    contextPlan?.edges.filter(
      (edge) => edge.from_node_id === contextNode?.id || edge.to_node_id === contextNode?.id,
    ) ?? [];
  const contextAtomicNodes = (contextPlan?.atomic_nodes ?? ledger.atomic_nodes).filter(
    (node) =>
      (node.kind === "work" && node.scope?.kind === "task" && node.scope.task_id === taskId) ||
      (node.kind === "milestone" && node.scope?.kind === "task" && node.scope.task_id === taskId),
  );
  return {
    task: contextTask,
    delivery_unit: contextTask
      ? ledger.groups.find((item) => item.id === contextTask.group_id)
      : null,
    plan_node: contextNode ?? null,
    dependency_edges: contextEdges,
    atomic_nodes: contextAtomicNodes,
    atomic_edges: (contextPlan?.atomic_edges ?? ledger.atomic_edges).filter((edge) =>
      contextAtomicNodes.some(
        (node) => node.id === edge.from_node_id || node.id === edge.to_node_id,
      ),
    ),
    resources: contextTask
      ? ledger.resources.filter(
          (resource) =>
            resource.target === contextTask.id ||
            resource.target === contextTask.thread_id ||
            resource.target === contextTask.branch,
        )
      : [],
    ready: taskId ? ready(ledger, taskId) : false,
    dispatch_eligibility: contextTask ? taskDispatchEligibility(ledger, contextTask) : null,
  };
}
