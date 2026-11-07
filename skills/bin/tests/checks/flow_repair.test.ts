import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeHistoricalReplay } from "../../modules/checks";
import {
  flowFromText,
  isContinue,
  isRouteAttempt,
  routeIsValid,
} from "../../modules/checks/flow_support";

const codes = (path: string): string[] => [
  ...new Set(
    analyzeHistoricalReplay(path, "flow").findings.map((item) => item.code),
  ),
];

describe("flow repair route parity", () => {
  test("multiline repair commands remain invalid routes", () => {
    const temporary = mkdtempSync(join(tmpdir(), "checks-flow-"));
    try {
      const replayPath = join(temporary, "flow.jsonl");
      const records = [
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "flow_type: fast-track" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "<proposed_plan>\n## Flow Decision\n- flow_type: fast-track\n- lock_status: locked\n</proposed_plan>",
              },
            ],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Recovery facts: permit_status=issued; base_relation=fast-forward; live_pr_match=true.",
              },
            ],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "继续" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "python3 skills/bin/flow_receipt.py --repo . review-wave open --stage repair --base-ref origin/main --lane contract:gpt-5.6-luna:high --previous-head-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --repair-permit-id permit-fixture-001\nprintf injected",
            }),
          },
        },
      ];
      writeFileSync(
        replayPath,
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      expect(codes(replayPath)).toContain(
        "REPAIR_PERMIT_BASE_ADVANCE_INVALID_ROUTE",
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("continuation negation uses the Python proximity window", () => {
    expect(isContinue("[$flow-continue]" + "x".repeat(65) + " wait")).toBe(
      true,
    );
    expect(isContinue("[$flow-continue] wait")).toBe(false);
  });

  test("recognizes active multi-task flow aliases", () => {
    expect(flowFromText("flow_type: multi_task_flow")).toBe("multi-task-flow");
    expect(flowFromText("采用多任务流程")).toBe("multi-task-flow");
  });

  test("repair routes require an executable function name", () => {
    const payload = {
      name: "narrative_tool",
      arguments: JSON.stringify({
        cmd: "python3 skills/bin/flow_receipt.py --repo . review-wave open --stage repair --base-ref origin/main --lane security --previous-head-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --repair-permit-id permit-x",
      }),
    };
    expect(isRouteAttempt("function_call", payload)).toBe(false);
    expect(routeIsValid(payload)).toBe(false);
  });

  test("Bun flow receipt paths remain routable", () => {
    for (const executable of [
      "bun skills/bin/flow_receipt.ts",
      "bun run skills/bin/flow_receipt.ts",
    ]) {
      const payload = {
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: `${executable} --repo . review-wave open --stage repair --base-ref origin/main --lane contract:gpt-5.6-luna:high --previous-head-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --repair-permit-id permit-ts`,
        }),
      };
      expect(isRouteAttempt("function_call", payload)).toBe(true);
      expect(routeIsValid(payload)).toBe(true);
    }
  });

  test("repair facts ignore arbitrary function output fields", () => {
    const temporary = mkdtempSync(join(tmpdir(), "checks-flow-"));
    try {
      const replayPath = join(temporary, "flow.jsonl");
      const records = [
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "flow_type: local-merge" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "<proposed_plan>\n## Flow Decision\n- flow_type: local-merge\n- lock_status: locked\n</proposed_plan>",
              },
            ],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Verified recovery facts: permit_status=issued; base_relation=fast-forward; live_pr_match=true.",
              },
            ],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            output: {
              note: "permit_status=revoked; base_relation=diverged; live_pr_match=false",
            },
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            output: [{ release_disposition: "managed" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Continue [$flow-continue]" },
            ],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "python3 skills/bin/flow_receipt.py --repo . review-wave open --stage repair --base-ref origin/main --head-sha 1111111111111111111111111111111111111111 --scope-class code --lane contract:gpt-5.6-luna:high --previous-head-sha ffffffffffffffffffffffffffffffffffffffff --repair-permit-id permit-fixture-002",
            }),
          },
        },
      ];
      writeFileSync(
        replayPath,
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      expect(codes(replayPath)).toEqual([]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
