import { describe, expect, test } from "bun:test";
import { runProcess } from "../../modules/core/process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const CHECKER = resolve(ROOT, "bin/plan_contract_check.ts");
const DIRECT_PLAN = resolve(
  ROOT,
  "skills/dev-plan/references/plan-cases/positive-fast-track.md",
);
const HISTORICAL_PLACEHOLDER = resolve(
  ROOT,
  "skills/dev-plan/references/replay-cases/non-goals-placeholder.jsonl",
);
const HISTORICAL_MULTI_PLAN = resolve(
  ROOT,
  "skills/dev-plan/references/replay-cases/positive-multi-plan-baseline-reset-generic-reask.jsonl",
);

async function checker(args: string[], stdin = "") {
  return runProcess({
    command: process.execPath,
    args: ["run", CHECKER, ...args],
    cwd: ROOT,
    stdin,
    env: { ...process.env, PLAN_CONTRACT_REPO_ROOT: ROOT },
  });
}

describe("TypeScript plan contract checker", () => {
  test("accepts a valid fast-track raw plan", async () => {
    const plan = await Bun.file(DIRECT_PLAN).text();
    const result = await checker(["--plan", "-"], plan);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PASS file=<stdin> checks=ok");
  });

  test("rejects missing flow fields and malformed orchestration", async () => {
    const plan = (await Bun.file(DIRECT_PLAN).text())
      .replace("- `flow_type`: `fast-track`\n", "")
      .replace("- wave: 1\n", "");
    const result = await checker(["--plan", "-"], plan);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("MISSING_FLOW_TYPE");
    expect(result.stdout).toContain("TASK_ORCHESTRATION_WAVE_MISSING");
  });

  test("rejects multi-task-flow as an external runtime route", async () => {
    const plan = (await Bun.file(DIRECT_PLAN).text()).replace(
      "fast-track",
      "multi-task-flow",
    );
    const result = await checker(["--plan", "-"], plan);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("DEV_PLAN_MULTI_TASK_FLOW_FORBIDDEN");
  });

  test("rejects blank and placeholder non-goals", async () => {
    const plan = (await Bun.file(DIRECT_PLAN).text()).replace(
      "- N1: 不 push debug logs，也不合并 PR 或执行本地 cleanup。",
      "-\n- none",
    );
    const result = await checker(["--plan", "-"], plan);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("EMPTY_NON_GOALS");
  });

  test("rejects historical non-goal placeholders", async () => {
    const result = await checker([HISTORICAL_PLACEHOLDER]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("NON_GOAL_PLACEHOLDER");
  });

  test("rejects duplicate flow fields in historical JSONL", async () => {
    const source = await Bun.file(
      resolve(
        ROOT,
        "skills/dev-plan/references/replay-cases/positive-wave-thread-v2-legacy.jsonl",
      ),
    ).text();
    const session =
      source
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const row = JSON.parse(line);
          for (const item of row.payload?.content ?? []) {
            if (
              typeof item.text === "string" &&
              item.text.includes("<proposed_plan>")
            )
              item.text = item.text.replace(
                "- `flow_type`: `wave-thread`",
                "- `flow_type`: `wave-thread`\n- `flow_type`: `normal`",
              );
          }
          return JSON.stringify(row);
        })
        .join("\n") + "\n";
    const root = mkdtempSync(join(tmpdir(), "plan-duplicate-flow-"));
    const path = join(root, "session.jsonl");
    writeFileSync(path, session);
    try {
      const result = await checker([path]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("DUPLICATE_FLOW_FIELD");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("joins historical plans split across assistant content items", async () => {
    const source = await Bun.file(HISTORICAL_MULTI_PLAN).text();
    const rows = source
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const row = rows.find((candidate) =>
      candidate.payload?.content?.some((item: any) =>
        item.text?.includes("<proposed_plan>"),
      ),
    );
    expect(row).toBeDefined();
    const content = row.payload.content;
    const plan = content.find((item: any) =>
      item.text?.includes("<proposed_plan>"),
    ).text;
    const split = plan.indexOf("</proposed_plan>");
    content.splice(
      0,
      content.length,
      { text: plan.slice(0, split) },
      { text: plan.slice(split) },
    );
    const root = mkdtempSync(join(tmpdir(), "plan-split-content-"));
    const path = join(root, "session.jsonl");
    writeFileSync(
      path,
      rows.map((candidate) => JSON.stringify(candidate)).join("\n") + "\n",
    );
    try {
      const result = await checker([path]);
      expect(result.stdout).not.toContain("HISTORICAL_PROPOSED_PLAN_INVALID");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not reuse a prior plan's flow token for a later user request", async () => {
    const session = (await Bun.file(HISTORICAL_MULTI_PLAN).text())
      .replace("请再给我一份新的可执行计划。", "继续")
      .replace(
        "`flow_source`: `default_fast_track`",
        "`flow_source`: `user_explicit`",
      );
    const root = mkdtempSync(join(tmpdir(), "plan-replay-"));
    const path = join(root, "session.jsonl");
    writeFileSync(path, session);
    try {
      const result = await checker([path]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("FLOW_NOT_LOCKED_BEFORE_PLAN");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects persisted planning artifacts in canonical orchestration", async () => {
    const plan = (await Bun.file(DIRECT_PLAN).text()).replace(
      "main-agent => 创建或复用 PR 并收敛 current head (skill: $fast-flow)",
      "main-agent => create a fresh PLAN.md for future sessions",
    );
    const result = await checker(["--plan", "-"], plan);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "TASK_ORCHESTRATION_PERSISTED_PLAN_ARTIFACT_FORBIDDEN",
    );
  });
});

test("keeps raw-plan diagnostics through Bun without invoking Python", async () => {
  const result = await checker(["--plan", "-"], "invalid plan");
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain("FINDING");
  expect(result.stdout + result.stderr).not.toContain("Traceback");
});
test("preserves standalone CLI cwd paths and argparse exit codes", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plan-cli-cwd-")));
  try {
    const result = await runProcess({
      command: process.execPath,
      args: [CHECKER, "--plan", DIRECT_PLAN],
      cwd: root,
      env: { ...process.env, PLAN_CONTRACT_REPO_ROOT: ROOT },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("checks=ok");
    expect((await checker([])).exitCode).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("development-only direct Bun preserves output on acceptance failure", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "plan-acceptance-cli-")),
  );
  try {
    const output = join(root, "existing.json");
    writeFileSync(output, "keep\n");
    const result = await runProcess({
      command: process.execPath,
      args: [
        resolve(ROOT, "bin/plan_acceptance_manifest.ts"),
        "--input",
        "-",
        "--output",
        output,
      ],
      cwd: root,
      stdin: "invalid plan",
      env: { ...process.env, PLAN_CONTRACT_REPO_ROOT: root },
    });
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(output, "utf8")).toBe("keep\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("rejects a candidate entrypoint with a symlinked parent", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plan-entrypoint-")));
  try {
    const linked = join(root, "linked");
    symlinkSync(resolve(ROOT, "bin"), linked);
    const result = await runProcess({
      command: process.execPath,
      args: [resolve(ROOT, "bin/plan_review_view.ts"), "--help"],
      cwd: ROOT,
      env: {
        ...process.env,
        PLAN_REVIEW_ENTRYPOINT_PATH: join(linked, "plan_review_view.ts"),
      },
      timeoutMs: 3000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).not.toContain("usage:");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("rejects a FIFO candidate entrypoint without blocking", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "plan-entrypoint-fifo-")),
  );
  try {
    const fifo = join(root, "entry.ts");
    expect(
      (await runProcess({ command: "mkfifo", args: [fifo] })).exitCode,
    ).toBe(0);
    const result = await runProcess({
      command: process.execPath,
      args: [resolve(ROOT, "bin/plan_review_view.ts"), "--help"],
      cwd: ROOT,
      env: { ...process.env, PLAN_REVIEW_ENTRYPOINT_PATH: fifo },
      timeoutMs: 3000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).not.toContain("usage:");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
