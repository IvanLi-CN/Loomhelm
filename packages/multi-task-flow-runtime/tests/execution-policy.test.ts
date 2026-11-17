import { expect, test } from "bun:test";
import type { Task } from "../lib/schema-models";
import { taskExecutionPolicyIssues } from "../lib/schema-policies";
import { deriveExecutionPolicy } from "../web/execution-policy-model";

test("all 20 policy pairs agree with the domain validator, retaining four valid configuration states", () => {
  let valid = 0;
  for (const owner of [null, "main", "delivery_agent", "task_agent"] as const) {
    for (const conversation of [
      null,
      "main_owned",
      "delivery_owned",
      "task_agent",
      "none",
    ] as const) {
      const policy = {
        execution_owner: owner,
        conversation_policy: conversation,
        delivery_policy:
          owner === null && conversation === null
            ? null
            : owner === "task_agent"
              ? "child_pr"
              : "evidence",
      } satisfies Pick<Task, "execution_owner" | "conversation_policy" | "delivery_policy">;
      const projected = deriveExecutionPolicy(owner, conversation);
      const accepted = taskExecutionPolicyIssues(policy).length === 0;
      expect(["main", "delivery_agent", "task_agent", "undeclared"].includes(projected.state)).toBe(
        accepted,
      );
      if (accepted) valid++;
    }
  }
  expect(valid).toBe(4);
});

test("missing fields and future enum values cannot masquerade as a declared Agent", () => {
  for (const [owner, conversation] of [
    [undefined, undefined],
    ["new_agent", "task_agent"],
    ["task_agent", "future"],
    [" ", " "],
    [false, null],
  ])
    expect(deriveExecutionPolicy(owner, conversation).state).toBe("unknown");
  expect(deriveExecutionPolicy(null, "task_agent").state).toBe("incomplete");
  expect(deriveExecutionPolicy("main", "none").state).toBe("conflict");
});
