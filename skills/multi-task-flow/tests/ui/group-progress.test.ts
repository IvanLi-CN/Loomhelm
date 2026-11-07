import { expect, test } from "bun:test";
import { groupAtomProgress } from "../../web/cards";

test("distinguishes unstarted atoms and generic waiting from contribution waiting", () => {
  const group = { atoms: [{ id: "one", title: "准备", status: "planned" }], coordination_execution: { state: "unknown", waiting_for_task_ids: [] } } as any;
  expect(groupAtomProgress(group)).toBe("0/1 · 待开始");
  group.coordination_execution.state = "waiting";
  expect(groupAtomProgress(group)).toBe("0/1 · 待开始 · 等待中");
  group.atoms[0].status = "running";
  group.coordination_execution.waiting_for_task_ids = ["a"];
  expect(groupAtomProgress(group)).toBe("1/1 · 准备 · 等待贡献任务");
  group.atoms[0].status = "completed";
  expect(groupAtomProgress(group)).toBe("1/1 · 已完成");
});
