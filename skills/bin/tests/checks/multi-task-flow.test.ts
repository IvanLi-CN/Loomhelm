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
  expect(skill).toContain("候选 `init-input.json` 或打开工具的成功回执均不算交付");
  expect(skill).toContain("优先从宿主浏览器清单选择 `ChatGPT in-app browser`");
  expect(skill).toContain("宿主未提供该浏览器时，按 `$ego-browser` 执行");
  expect(skill).toContain("保持页面打开接收 SSE／heartbeat 更新");
  expect(skill).toContain("实现计划批准覆盖计划内的对话、工作区、push");
  expect(spec).toContain("REQ-ORCH-013");
  expect(viewer).toContain("正常 ledger 修订保持同一页面");
});

test("multi-task-flow CLI documentation pins package and service identity", () => {
  const skill = readFileSync(
    join(repositoryRoot, "skills/multi-task-flow/SKILL.md"),
    "utf8",
  );
  const viewer = readFileSync(
    join(repositoryRoot, "skills/multi-task-flow/references/shared-viewer.md"),
    "utf8",
  );
  const packageReadme = readFileSync(
    join(repositoryRoot, "clients/typescript/README.md"),
    "utf8",
  );
  const examples = readFileSync(
    join(repositoryRoot, "packages/multi-task-flow-runtime/examples/README.md"),
    "utf8",
  );
  const designData = readFileSync(
    join(
      repositoryRoot,
      "skills/docs/vendor/dot-codex/design/multi-task-flow/data-and-scripts.md",
    ),
    "utf8",
  );
  const designExecution = readFileSync(
    join(
      repositoryRoot,
      "skills/docs/vendor/dot-codex/design/multi-task-flow/execution.md",
    ),
    "utf8",
  );
  const designWeb = readFileSync(
    join(
      repositoryRoot,
      "skills/docs/vendor/dot-codex/design/multi-task-flow/web-template.md",
    ),
    "utf8",
  );
  const packageAdr = readFileSync(
    join(repositoryRoot, "docs/adr/0032-package-backed-dashboard-daemon.md"),
    "utf8",
  );
  for (const document of [
    skill,
    viewer,
    packageReadme,
    examples,
    designData,
    designExecution,
    designWeb,
    packageAdr,
  ]) {
    expect(document).toContain("bunx --bun @loomhelm/multi-task-flow@<exact-version>");
  }
  for (const document of [skill, viewer, packageReadme]) {
    expect(document).toContain("npx");
  }
  expect(skill).toContain("[共享 viewer](references/shared-viewer.md)");
  for (const document of [viewer, packageReadme]) {
    expect(document).toContain("service.json");
    expect(document).toContain("current_build");
  }
  expect(designData).not.toContain("`multi-task-flow flow <command> --input -`");
  expect(designData).not.toContain("`orchestrate.ts migrate --input -`");
  expect(designExecution).not.toContain("`orchestrate.ts init`");
  expect(designExecution).not.toContain("`service.ts ensure`");
  expect(designWeb).not.toContain("`multi-task-flow service ensure --input -`");
  expect(packageAdr).not.toContain("bun x --bun --package @loomhelm/multi-task-flow");
});

test("multi-task-flow documents the coordinator-only native conversation boundary", () => {
  const skill = readFileSync(
    join(repositoryRoot, "skills/multi-task-flow/SKILL.md"),
    "utf8",
  );
  const plan = readFileSync(
    join(repositoryRoot, "skills/multi-task-flow/references/plan-and-graph.md"),
    "utf8",
  );
  expect(skill).toContain("任何 Agent 都不得调用 `mcp__codex_app__create_thread`");
  expect(skill).toContain("→ conversation-create → native evidence reconcile → formal dispatch");
  expect(skill).toContain("capability gap");
  expect(skill).toContain("orphan thread / orchestration violation");
  expect(skill).toContain("保留 claim 和容量，暂停受影响运行");
  expect(plan).toContain("原子图 MUST 明确声明开始节点、结束节点、里程碑节点和全部 `atomic_edges`");
  expect(plan).toContain("系统预设的交付单元生命周期原子只提供节点定义，不提供依赖关系");
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
