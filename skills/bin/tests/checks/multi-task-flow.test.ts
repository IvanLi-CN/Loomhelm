import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeHistoricalReplay } from "../../modules/checks";
import {
  canonicalFlowType,
  flowType,
} from "../../modules/checks/pr_terminal_support";
import { isNestedTaskFlow } from "../../modules/checks/flow_support";
import { scanTerminal } from "../../modules/checks/pr_terminal_scan";
import { createTerminalState } from "../../modules/checks/pr_terminal_state";

const repositoryRoot = join(import.meta.dir, "../../../..");

const codes = (value: { findings: Array<{ code: string }> }): string[] =>
  [...new Set(value.findings.map((item) => item.code))].sort();

test("multi-task-flow documents require formal dashboard delivery", () => {
  const skill = readFileSync(
    join(repositoryRoot, "skills/multi-task-flow/SKILL.md"),
    "utf8",
  );
  const spec = readFileSync(
    join(repositoryRoot, "skills/docs/vendor/dot-codex/specs/multi-task-flow/SPEC.md"),
    "utf8",
  );
  const execution = readFileSync(
    join(repositoryRoot, "skills/docs/vendor/dot-codex/design/multi-task-flow/execution.md"),
    "utf8",
  );
  const viewer = readFileSync(
    join(repositoryRoot, "skills/docs/vendor/dot-codex/design/multi-task-flow/shared-viewer.md"),
    "utf8",
  );
  expect(skill).toContain("initialized run");
  expect(spec).toContain("初始化");
  expect(execution).toContain("正式");
  expect(viewer).toContain("revision");
  expect(skill).toContain("candidate `init-input.json`");
  expect(skill).toContain("built-in browser");
  expect(skill).toContain("SSE and heartbeat");
  expect(skill).toContain("Git push");
  expect(spec).toContain("REQ-ORCH-013");
  expect(viewer).toContain("正常 ledger 修订保持同一页面");
});

test("multi-task-flow task-local direct delivery requires an open PR", () => {
  const temporary = mkdtempSync(join(tmpdir(), "checks-multi-task-terminal-"));
  try {
    const records = [
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "flow_type: multi-task-flow" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "lock_status: locked" }],
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
              text: "task-local direct PR local proof; current head is live and bound",
            },
          ],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "multi-task-local-pr",
          last_agent_message: "task-local direct PR complete; no open PR",
        },
      },
    ];
    const replayPath = join(temporary, "terminal.jsonl");
    writeFileSync(
      replayPath,
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    expect(codes(analyzeHistoricalReplay(replayPath))).toContain(
      "FAST_TRACK_STOPPED_BEFORE_PR",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("multi-task-flow terminal aliases are canonicalized", () => {
  for (const alias of [
    "multi_task_flow",
    "multi task flow",
    "multi-task",
    "多任务流程",
  ]) {
    const match = flowType.exec(`flow_type: ${alias}`);
    expect(match?.[1]).toBe(alias);
    expect(canonicalFlowType(alias)).toBe("multi-task-flow");
  }
});

test("nested fast-flow retains the parent multi-task route", () => {
  const temporary = mkdtempSync(join(tmpdir(), "checks-nested-fast-flow-"));
  try {
    const replayPath = join(temporary, "terminal.jsonl");
    const records = [
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "flow_type: multi-task-flow" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "lock_status: locked" }],
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
              text: "<proposed_plan>\n## Flow Decision\n- flow_type: fast-track\n</proposed_plan>",
            },
          ],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "lock_status: locked" }],
        },
      },
    ];
    writeFileSync(
      replayPath,
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const state = createTerminalState();
    scanTerminal(state, replayPath);

    expect(state.parentFlow).toBe("multi-task-flow");
    expect(state.taskFlow).toBe("fast-track");
    expect(state.fastTrackLine).toBe(4);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("assistant task plans do not become top-level flow switches", () => {
  expect(
    isNestedTaskFlow(
      "multi-task-flow",
      "fast-track",
      "assistant",
      "<proposed_plan>\n## Flow Decision\n- flow_type: fast-track\n</proposed_plan>",
    ),
  ).toBe(true);
  expect(
    isNestedTaskFlow(
      "multi-task-flow",
      "fast-track",
      "assistant",
      "explicit top-level flow switch: flow_type: fast-track",
    ),
  ).toBe(false);
});
