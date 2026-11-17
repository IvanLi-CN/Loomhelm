import { expect, test } from "bun:test";
import { deliveryPolicyChip, executionPolicyChip } from "../../web/execution-policy-chip";

test("one icon plus Agent text preserves both original fields on keyboard focus", () => {
  const chip = executionPolicyChip("task_agent", "task_agent");
  document.body.append(chip);
  const trigger = chip.querySelector<HTMLElement>(".detail-policy-trigger")!;
  expect(trigger.textContent).toBe("Task Agent");
  expect(trigger.querySelectorAll("svg")).toHaveLength(1);
  trigger.focus();
  const tooltip = chip.querySelector<HTMLElement>('[role="tooltip"]')!;
  expect(tooltip.hidden).toBe(false);
  expect(tooltip.textContent).toContain('execution_owner: "task_agent"');
  expect(tooltip.textContent).toContain('conversation_policy: "task_agent"');
  chip.remove();
});

test("fallback chips preserve raw conflicts, null and missing values", () => {
  const conflict = executionPolicyChip("main", "task_agent");
  expect(conflict.dataset.policyState).toBe("conflict");
  expect(conflict.textContent).toContain('conversation_policy: "task_agent"');
  expect(executionPolicyChip(null, null).textContent).toContain("null（未声明）");
  expect(executionPolicyChip(undefined, null).textContent).toContain("undefined（字段缺失）");
  const delivery = deliveryPolicyChip("child_pr");
  expect(delivery.querySelector(".detail-policy-trigger")?.textContent).toBe("子 PR");
  expect(delivery.textContent).toContain('delivery_policy: "child_pr"');
  expect(delivery.querySelectorAll("svg")).toHaveLength(1);
});
