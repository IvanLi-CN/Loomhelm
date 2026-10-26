import { describe, expect, test } from "bun:test";

import {
  isMutationNoticeReconciliationReady,
  mergePersistedMutationNoticeState,
  mutationWriteAdmission,
  sameMutationNoticeContent,
  syncTaskRelations,
  type MutationNotice
} from "../src/features/projects/production-source";

function taskNotice(overrides: Partial<MutationNotice> = {}): MutationNotice {
  return {
    id: "task:create:legacy",
    message: "任务创建结果待确认。",
    kind: "creation",
    lockScope: "task:create",
    taskId: "task-known",
    ...overrides
  };
}

describe("U02 Batch14 production mutation boundary", () => {
  test("keeps an unresolved notice after an ambiguous storage removal", () => {
    const notice = taskNotice({ lockScope: "task:task-known" });
    const emptySharedState = { available: true, shared: true, notices: [] };

    expect(mergePersistedMutationNoticeState([notice], emptySharedState, [], true)).toEqual([notice]);
    expect(mutationWriteAdmission("task:task-known", [notice], new Map(), emptySharedState)).toBe("notice");
    expect(mutationWriteAdmission("task:task-known", [], new Map(), { available: false, shared: false, notices: [] })).toBe("storage");
  });

  test("blocks the production write boundary for refreshing, current, and persisted scopes", () => {
    const notice = taskNotice({ lockScope: "task:target" });
    const readable = { available: true, shared: true, notices: [] };

    expect(mutationWriteAdmission("task:target", [], new Map([["task:target", 1]]), readable)).toBe("refreshing");
    expect(mutationWriteAdmission("task:target", [notice], new Map(), readable)).toBe("notice");
    expect(mutationWriteAdmission("task:target", [], new Map(), { ...readable, notices: [notice] })).toBe("storage");
    expect(mutationWriteAdmission("task:other", [], new Map(), readable)).toBeUndefined();
  });

  test("does not confirm an absent preselected creation identity", () => {
    const notice = taskNotice({ kind: "reconciliation" });

    expect(isMutationNoticeReconciliationReady([notice], "task", false)).toBe(false);
    expect(isMutationNoticeReconciliationReady([notice], "task", true)).toBe(true);
  });

  test("requires the exact notice version before acknowledgement can remove it", () => {
    const expected = taskNotice();

    expect(sameMutationNoticeContent(expected, { ...expected })).toBe(true);
    expect(sameMutationNoticeContent(expected, { ...expected, message: "另一个标签页已更新。" })).toBe(false);
    expect(sameMutationNoticeContent(expected, { ...expected, taskId: "task-other" })).toBe(false);
  });

  test("keeps unaffected relation writes available after one relation fails", async () => {
    const calls: string[] = [];
    const result = await syncTaskRelations({
      addTaskParent: async ({ parent_task_id }) => { calls.push(`parent:${parent_task_id}`); },
      removeTaskParent: async ({ parent_task_id }) => { calls.push(`remove-parent:${parent_task_id}`); },
      addTaskDependency: async ({ prerequisite_task_id }) => {
        calls.push(`dependency:${prerequisite_task_id}`);
        throw new Error("dependency unavailable");
      },
      removeTaskDependency: async ({ prerequisite_task_id }) => { calls.push(`remove-dependency:${prerequisite_task_id}`); }
    }, { invalidateQueries: async () => undefined } as never, "principal-1", 1, "task-known", {
      addParentIds: ["parent-ok"],
      addDependencyIds: ["dependency-failed"]
    });

    expect(calls).toEqual(["parent:parent-ok", "dependency:dependency-failed"]);
    expect(result.failures).toHaveLength(1);
    expect(result.applied).toEqual({ addParentIds: ["parent-ok"], addDependencyIds: undefined });
  });
});
