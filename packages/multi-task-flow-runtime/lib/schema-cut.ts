import { z } from "zod";
import { requireCondition } from "../lib/errors";
import { canonicalJson, sameMembers, sameTaskStructure, taskStateAtEvent } from "./schema-handoff";
import { cutEvidence, group, id, type Ledger, type Plan, task } from "./schema-models";
import { isContributionKind } from "./schema-policies";

const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

export type CutAssignmentEvidence = {
  assignments: Map<string, Set<string>>;
  dynamicGroupIds: Set<string>;
};

export function collectCutAssignmentEvidence(ledger: Ledger, active: Plan): CutAssignmentEvidence {
  const currentGroups = new Map<string, string>();
  for (const node of active.nodes.filter((item) => item.kind === "task"))
    if (node.ref_id !== null && node.group_id !== null)
      currentGroups.set(node.ref_id, node.group_id);
  const assignments = new Map<string, Set<string>>();
  const dynamicGroupIds = new Set<string>();
  const appliedOperationIds = new Set<string>();
  const createdGroupIds = new Set<string>();
  for (const [eventIndex, event] of ledger.events.entries()) {
    if (event.type !== "cut_applied") continue;
    const operationId = event.data.operation_id;
    const oldGroupId = event.data.old_group_id;
    const newGroupId = event.data.new_group_id;
    const cutSha = event.data.cut_sha;
    const oldGroupCurrentSha = event.data.old_group_current_sha;
    const includedTaskIds = event.data.included_task_ids;
    const reassignedTaskIds = event.data.reassigned_task_ids;
    const cutEvidenceValue = event.data.cut_evidence;
    requireCondition(
      id.safeParse(operationId).success &&
        id.safeParse(oldGroupId).success &&
        id.safeParse(newGroupId).success &&
        sha.safeParse(cutSha).success &&
        oldGroupCurrentSha === cutSha &&
        Array.isArray(includedTaskIds) &&
        includedTaskIds.every((item) => id.safeParse(item).success) &&
        Array.isArray(reassignedTaskIds) &&
        reassignedTaskIds.every((item) => id.safeParse(item).success),
      "INVALID_CUT_EVENT",
      "cut_applied event has invalid assignment evidence",
    );
    requireCondition(
      !appliedOperationIds.has(operationId as string) && !createdGroupIds.has(newGroupId as string),
      "INVALID_CUT_EVENT",
      "cut_applied event reuses a cut operation or dynamic group",
    );
    requireCondition(
      event.subject_id === oldGroupId && oldGroupId !== newGroupId,
      "INVALID_CUT_EVENT",
      "cut_applied event subject does not match its old group",
    );
    const operation = ledger.operations.find((item) => item.id === operationId);
    requireCondition(
      operation !== undefined &&
        operation.kind === "cut" &&
        operation.status === "succeeded" &&
        operation.target_id === oldGroupId &&
        operation.request.operation_id === operationId &&
        operation.request.group_id === oldGroupId &&
        operation.expected_sha === cutSha,
      "INVALID_CUT_EVENT",
      "cut_applied event is not bound to a succeeded cut operation",
    );
    const oldGroup = ledger.groups.find((item) => item.id === oldGroupId);
    const newGroup = ledger.groups.find((item) => item.id === newGroupId);
    requireCondition(
      oldGroup !== undefined && newGroup !== undefined,
      "INVALID_CUT_EVENT",
      "cut_applied event references an unknown group",
    );
    const ruleId = operation?.request.rule_id;
    const rule = active.cut_rules.find((item) => item.id === ruleId);
    requireCondition(
      rule !== undefined,
      "INVALID_CUT_EVENT",
      "cut_applied event references an unknown cut rule",
    );
    const cutEvidenceResult = cutEvidence.safeParse(cutEvidenceValue);
    requireCondition(
      cutEvidenceResult.success && cutEvidenceResult.data.sha === cutSha,
      "INVALID_CUT_EVENT",
      "cut_applied event is missing verified provider evidence",
    );
    const cutClaim = ledger.events
      .slice(0, eventIndex)
      .find(
        (candidate) =>
          candidate.type === "cut_claimed" &&
          candidate.subject_id === oldGroupId &&
          candidate.actor_id === operation!.actor_id &&
          candidate.data.operation_id === operationId &&
          candidate.data.group_id === oldGroupId &&
          candidate.data.rule_id === ruleId &&
          sha.safeParse(candidate.data.expected_sha).success,
      );
    requireCondition(
      cutClaim !== undefined,
      "INVALID_CUT_EVENT",
      "cut_applied event is not preceded by a matching cut claim",
    );
    requireCondition(
      rule!.status === "applied",
      "INVALID_CUT_EVENT",
      "cut_applied event does not bind an applied cut rule",
    );
    let ruleGroupId = rule!.group_id;
    for (const previousEvent of ledger.events.slice(0, eventIndex))
      if (
        previousEvent.type === "cut_applied" &&
        previousEvent.data.old_group_id === ruleGroupId &&
        typeof previousEvent.data.new_group_id === "string"
      )
        ruleGroupId = previousEvent.data.new_group_id;
    requireCondition(
      ruleGroupId === oldGroupId,
      "INVALID_CUT_EVENT",
      "cut_applied event does not match its approved cut rule group",
    );
    requireCondition(
      oldGroup!.cut_sha === cutSha,
      "INVALID_CUT_EVENT",
      "cut_applied event does not bind the old group cut boundary",
    );
    requireCondition(
      event.data.new_group_state === "planned" &&
        event.data.new_group_agent_thread_id === null &&
        event.data.new_group_parent_branch === null &&
        event.data.new_group_parent_pr === null &&
        event.data.new_group_cut_sha === null &&
        event.data.new_group_current_sha === null &&
        event.data.new_group_merge_sha === null &&
        event.data.new_group_requirements_path === null,
      "INVALID_CUT_EVENT",
      "cut_applied event does not prove a clean dynamic group creation",
    );
    const initialGroupSnapshot = group.safeParse(event.data.new_group_snapshot);
    requireCondition(
      initialGroupSnapshot.success &&
        initialGroupSnapshot.data.id === newGroupId &&
        initialGroupSnapshot.data.state === "planned" &&
        initialGroupSnapshot.data.agent_thread_id === null &&
        initialGroupSnapshot.data.parent_branch === null &&
        initialGroupSnapshot.data.parent_pr === null &&
        initialGroupSnapshot.data.cut_sha === null &&
        initialGroupSnapshot.data.current_sha === null &&
        initialGroupSnapshot.data.merge_sha === null &&
        initialGroupSnapshot.data.requirements_path === null,
      "INVALID_CUT_EVENT",
      "cut_applied event is missing a clean dynamic group snapshot",
    );
    requireCondition(
      initialGroupSnapshot.data.state === event.data.new_group_state &&
        initialGroupSnapshot.data.agent_thread_id === event.data.new_group_agent_thread_id &&
        initialGroupSnapshot.data.parent_branch === event.data.new_group_parent_branch &&
        canonicalJson(initialGroupSnapshot.data.parent_pr) ===
          canonicalJson(event.data.new_group_parent_pr) &&
        initialGroupSnapshot.data.cut_sha === event.data.new_group_cut_sha &&
        initialGroupSnapshot.data.current_sha === event.data.new_group_current_sha &&
        initialGroupSnapshot.data.merge_sha === event.data.new_group_merge_sha &&
        initialGroupSnapshot.data.requirements_path === event.data.new_group_requirements_path,
      "INVALID_CUT_EVENT",
      "cut_applied event snapshot does not match its creation fields",
    );
    const oldGroupSnapshot = group.safeParse(event.data.old_group_snapshot);
    requireCondition(
      oldGroupSnapshot.success &&
        oldGroupSnapshot.data.id === oldGroupId &&
        oldGroupSnapshot.data.current_sha === cutSha &&
        oldGroupSnapshot.data.cut_sha === cutSha &&
        oldGroupSnapshot.data.title === oldGroup.title &&
        oldGroupSnapshot.data.agent_thread_id === oldGroup.agent_thread_id &&
        oldGroupSnapshot.data.parent_branch === oldGroup.parent_branch &&
        canonicalJson(oldGroupSnapshot.data.parent_pr) === canonicalJson(oldGroup.parent_pr) &&
        oldGroupSnapshot.data.requirements_path === oldGroup.requirements_path &&
        oldGroupSnapshot.data.merge_sha === null &&
        ["planned", "active", "blocked"].includes(oldGroupSnapshot.data.state),
      "INVALID_CUT_EVENT",
      "cut_applied event is missing the old group boundary snapshot",
    );
    const priorGroupEvidence = ledger.events
      .slice(0, eventIndex)
      .some((candidate) => candidate.subject_id === newGroupId);
    requireCondition(
      !priorGroupEvidence,
      "INVALID_CUT_EVENT",
      "cut_applied event reuses a group with prior runtime history",
    );
    let latestGroupSnapshot = initialGroupSnapshot.data;
    for (const laterEvent of ledger.events.slice(eventIndex + 1)) {
      if (laterEvent.subject_id !== newGroupId) continue;
      const snapshotField =
        laterEvent.type === "cut_applied"
          ? "old_group_snapshot"
          : [
                "thread_bound",
                "group_updated",
                "merge_resolved",
                "external_merge_reconciled",
              ].includes(laterEvent.type)
            ? "group_snapshot"
            : null;
      if (snapshotField === null) continue;
      const laterSnapshot = group.safeParse(laterEvent.data[snapshotField]);
      requireCondition(
        laterSnapshot.success && laterSnapshot.data.id === newGroupId,
        "INVALID_CUT_EVENT",
        `cut lifecycle event ${laterEvent.id} is missing a bound group snapshot`,
      );
      latestGroupSnapshot = laterSnapshot.data;
    }
    requireCondition(
      canonicalJson(latestGroupSnapshot) === canonicalJson(newGroup),
      "INVALID_CUT_EVENT",
      "cut lifecycle snapshots do not match the current dynamic group",
    );
    const included = includedTaskIds as string[];
    const reassigned = reassignedTaskIds as string[];
    requireCondition(
      new Set([...included, ...reassigned]).size === included.length + reassigned.length,
      "INVALID_CUT_EVENT",
      "cut_applied event overlaps included and reassigned tasks",
    );
    const expectedDevelopmentTaskIds = ledger.tasks
      .filter((task) => isContributionKind(task.kind) && currentGroups.get(task.id) === oldGroupId)
      .map((task) => task.id);
    requireCondition(
      sameMembers(expectedDevelopmentTaskIds, [...included, ...reassigned]),
      "INVALID_CUT_EVENT",
      "cut_applied event does not cover every old-delivery-unit contribution task",
    );
    const taskSnapshots = z.array(task).safeParse(event.data.task_snapshots);
    requireCondition(
      taskSnapshots.success &&
        sameMembers(
          taskSnapshots.data.map((item) => item.id),
          expectedDevelopmentTaskIds,
        ) &&
        taskSnapshots.data.every(
          (item) => item.group_id === oldGroupId && isContributionKind(item.kind),
        ),
      "INVALID_CUT_EVENT",
      "cut_applied event is missing complete task boundary snapshots",
    );
    const snapshotById = new Map(
      taskSnapshots.success ? taskSnapshots.data.map((item) => [item.id, item]) : [],
    );
    const boundaryStateById = new Map(
      expectedDevelopmentTaskIds.map((taskId) => [
        taskId,
        taskStateAtEvent(
          ledger,
          taskId,
          eventIndex,
          ledger.tasks.find((item) => item.id === taskId)?.state ?? "planned",
        ),
      ]),
    );
    requireCondition(
      [...boundaryStateById.values()].every((state) => state !== null),
      "INVALID_CUT_EVENT",
      "cut_applied event is missing task state history before the cut boundary",
    );
    for (const taskId of expectedDevelopmentTaskIds) {
      const task = ledger.tasks.find((item) => item.id === taskId);
      const snapshot = snapshotById.get(taskId);
      requireCondition(
        task !== undefined &&
          snapshot !== undefined &&
          sameTaskStructure(snapshot, task) &&
          snapshot.group_id === oldGroupId &&
          snapshot.state === boundaryStateById.get(taskId),
        "INVALID_CUT_EVENT",
        `cut_applied event has an invalid task boundary snapshot ${taskId}`,
      );
    }
    for (const taskId of included) {
      const task = ledger.tasks.find((item) => item.id === taskId);
      const snapshot = snapshotById.get(taskId);
      requireCondition(
        task !== undefined &&
          snapshot !== undefined &&
          isContributionKind(task.kind) &&
          currentGroups.get(taskId) === oldGroupId &&
          canonicalJson(task.assignment_history) === canonicalJson(snapshot.assignment_history) &&
          ["integrated", "closed"].includes(snapshot.state),
        "INVALID_CUT_EVENT",
        `cut_applied event has an invalid included task ${taskId}`,
      );
    }
    const reassignmentGroupId = newGroupId as string;
    const seenTaskIds = new Set<string>();
    for (const taskId of reassigned) {
      requireCondition(
        !seenTaskIds.has(taskId),
        "INVALID_CUT_EVENT",
        "cut_applied event repeats a reassigned task",
      );
      seenTaskIds.add(taskId);
      const task = ledger.tasks.find((item) => item.id === taskId);
      const snapshot = snapshotById.get(taskId);
      requireCondition(
        task !== undefined &&
          snapshot !== undefined &&
          isContributionKind(task.kind) &&
          isContributionKind(snapshot.kind) &&
          !["integrated", "completed", "closed"].includes(snapshot.state) &&
          currentGroups.get(taskId) === oldGroupId &&
          task.group_id === newGroupId &&
          task.assignment_history.some(
            (item) => item.group_id === newGroupId && item.cut_operation_id === operationId,
          ),
        "INVALID_CUT_EVENT",
        `cut_applied event has an invalid task boundary snapshot ${taskId}`,
      );
      requireCondition(
        snapshot !== undefined &&
          task.assignment_history.length > snapshot.assignment_history.length &&
          canonicalJson(task.assignment_history.slice(0, snapshot.assignment_history.length)) ===
            canonicalJson(snapshot.assignment_history) &&
          task.assignment_history[snapshot.assignment_history.length]?.cut_operation_id ===
            operationId,
        "INVALID_CUT_EVENT",
        `cut_applied event does not prove reassignment boundary for task ${taskId}`,
      );
      currentGroups.set(taskId, reassignmentGroupId);
      assignments.set(taskId, new Set([...(assignments.get(taskId) ?? []), reassignmentGroupId]));
    }
    const historyTaskIds = ledger.tasks
      .filter((task) =>
        task.assignment_history.some((item) => item.cut_operation_id === operationId),
      )
      .map((task) => task.id);
    requireCondition(
      sameMembers(historyTaskIds, reassigned),
      "INVALID_CUT_EVENT",
      "cut_applied event does not match assignment history",
    );
    appliedOperationIds.add(operationId as string);
    createdGroupIds.add(newGroupId as string);
    dynamicGroupIds.add(reassignmentGroupId);
  }
  for (const task of ledger.tasks)
    requireCondition(
      currentGroups.get(task.id) === task.group_id,
      "INVALID_CUT_EVENT",
      `runtime task ${task.id} has an unsupported group assignment`,
    );
  return { assignments, dynamicGroupIds };
}
