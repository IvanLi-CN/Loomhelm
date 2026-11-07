import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  canonicalFacts,
  expectedAcceptanceLines,
  expectedBatchCardLines,
  expectedTaskCardLines,
  flowType,
  projectionFindings,
  renderGraph,
  renderProjection,
  safeMermaidId,
} from "../../modules/plan/projection";
import {
  finalize,
  readCandidateInput,
  render as renderPlan,
} from "../../modules/plan/review";
import { threeBatchOverlapPlan } from "./fixtures";

const ROOT = resolve(import.meta.dir, "../../../..");
const WAVE_PLAN = resolve(
  ROOT,
  "skills/dev-plan/references/plan-cases/positive-wave-thread-v2.md",
);
const MULTI_TASK_PLAN = resolve(
  ROOT,
  "skills/dev-plan/references/plan-cases/positive-multi-task-flow.md",
);
const DIRECT_PLAN = resolve(
  ROOT,
  "skills/dev-plan/references/plan-cases/positive-fast-track.md",
);
const DUPLICATE_PLAN = resolve(
  ROOT,
  "skills/dev-plan/references/plan-cases/negative-wave-thread-v2-duplicate-contract.md",
);

setDefaultTimeout(20_000);

async function read(path: string): Promise<string> {
  return Bun.file(path).text();
}

function renderHistoricalProjection(plan: string): string {
  const [batches] = canonicalFacts(plan);
  return renderProjection(plan, batches);
}

describe("plan review projection", () => {
  test("projects direct tasks and separates post-merge acceptance", async () => {
    const plan = await read(DIRECT_PLAN);
    const output = await renderPlan(plan);
    expect(output).toContain("### task-1 · main-agent");
    expect(output).toContain("### PR 合并前验收");
    expect(output).toContain("### PR 合并后验收");
    const postMerge = await renderPlan(
      plan.replace("phase=`pre_merge`", "phase=`post_merge`"),
    );
    expect(postMerge.indexOf("Merge Receipt 已存在")).toBeGreaterThan(
      postMerge.indexOf("### PR 合并后验收"),
    );
  });

  test("resolves relative candidate inputs from the candidate root", async () => {
    const input = await readCandidateInput(
      "skills/dev-plan/references/plan-cases/positive-fast-track.md",
    );
    expect(input).toContain("#");
  });

  test("rejects candidate input traversal before opening outside files", async () => {
    await expect(readCandidateInput("../outside-plan.md")).rejects.toThrow(
      "PLAN_REVIEW_VIEW_INPUT_OUTSIDE_CANDIDATE",
    );
  });

  test("rejects duplicate routing, wrappers, malformed fences, and NUL input", async () => {
    const wave = await read(WAVE_PLAN);
    const duplicate = await finalize(await read(DUPLICATE_PLAN));
    expect(duplicate.findings[0]?.code).toBe("RETIRED_FLOW_TYPE");
    expect(
      (await finalize(`<proposed_plan>\n${wave}\n</proposed_plan>`)).findings[0]
        ?.code,
    ).toBe("DEV_PLAN_LEGACY_INPUT_FORBIDDEN");
    expect(
      (await finalize(`${wave}\n\`\`\`md\nunclosed`)).findings[0]?.code,
    ).toBe("DEV_PLAN_FENCED_BLOCK_INVALID");
    expect((await finalize(`${wave}\0`)).findings[0]?.code).toBe(
      "DEV_PLAN_INPUT_NUL_FORBIDDEN",
    );
  });

  test("rejects duplicate routing headings with flexible whitespace", async () => {
    const direct = await read(DIRECT_PLAN);
    const result = await finalize(`${direct}\n##\tFlow Decision\n`);
    expect(result.findings[0]?.code).toBe("DEV_PLAN_DUPLICATE_ROUTING_SECTION");
  });

  test("detects projection fact drift and keeps stable Mermaid IDs", async () => {
    const wave = await read(WAVE_PLAN);
    const output = renderHistoricalProjection(wave);
    const [batches] = canonicalFacts(wave);
    const drifted = output.replace("#### `A1`\n", "#### `removed`\n");
    expect(
      projectionFindings(drifted, batches, new Set(["A1", "A2"]))[0]?.code,
    ).toBe("DEV_PLAN_OWNER_VIEW_ACCEPTANCE_DRIFT");
    expect(safeMermaidId("task", "task-a1")).toBe("n_7461736b__7461736b2d6131");
  });

  test("rejects acceptance tables and duplicate acceptance cards", async () => {
    const wave = await read(WAVE_PLAN);
    const output = renderHistoricalProjection(wave);
    const [batches] = canonicalFacts(wave);
    const acceptanceStart = output.indexOf("### PR 合并前验收");
    const closeoutStart = output.indexOf("## 9. Review", acceptanceStart);
    const tableProjection = [
      output.slice(0, acceptanceStart),
      "### PR 合并前验收",
      "",
      "| ID | 必须证明 | 验证 |",
      "| --- | --- | --- |",
      "| `A1` | target | evidence |",
      "",
      "### PR 合并后验收",
      "",
      "- 无适用验收项。",
      "",
      output.slice(closeoutStart),
    ].join("\n");
    expect(
      projectionFindings(tableProjection, batches, new Set(["A1"]))[0]?.code,
    ).toBe("DEV_PLAN_OWNER_VIEW_ACCEPTANCE_TABLE_FORBIDDEN");

    const firstCardStart = output.indexOf("#### `A1`");
    const nextCardStart = output.indexOf("\n#### ", firstCardStart + 1);
    const firstCard = output.slice(firstCardStart, nextCardStart);
    const duplicateProjection =
      output.slice(0, nextCardStart) +
      "\n" +
      firstCard +
      output.slice(nextCardStart);
    expect(
      projectionFindings(duplicateProjection, batches, new Set(["A1"]))[0]
        ?.code,
    ).toBe("DEV_PLAN_OWNER_VIEW_ACCEPTANCE_DUPLICATE");
  });

  test("checks task cards against independent canonical expectations", async () => {
    const wave = await read(WAVE_PLAN);
    const [batches] = canonicalFacts(wave);
    const drifted = renderHistoricalProjection(wave).replace(
      "Validate the canonical batch and task facts before projection.",
      "Wrong task purpose",
    );
    expect(
      projectionFindings(
        drifted,
        batches,
        new Set(["A1"]),
        expectedBatchCardLines(batches),
        expectedTaskCardLines(batches),
        expectedAcceptanceLines(wave),
      )[0]?.code,
    ).toBe("DEV_PLAN_OWNER_VIEW_FACT_DRIFT");
  });

  test("renders prototype-named Flow Decision extensions as plain labels", async () => {
    const wave = await read(WAVE_PLAN);
    const plan = wave.replace(
      "- `empirical_acceptance`: `not_required`",
      "- `empirical_acceptance`: `not_required`\n- `constructor`: `fixture metadata`\n- `__proto__`: `prototype metadata`\n- `toString`: `string metadata`",
    );
    const projection = renderHistoricalProjection(plan);
    expect(projection).toContain("- constructor：`fixture metadata`");
    expect(projection).toContain("- \\_\\_proto\\_\\_：`prototype metadata`");
    expect(projection).toContain("- toString：`string metadata`");
  });

  test("rejects unpaired UTF-16 surrogates as invalid input encoding", async () => {
    const result = await finalize(`${await read(WAVE_PLAN)}\ud800`);
    expect(result.findings[0]?.code).toBe("DEV_PLAN_INPUT_ENCODING_INVALID");
  });

  test("escapes autolink URLs in copied plan text", async () => {
    const plan = (await read(DIRECT_PLAN)).replace(
      "- 交付一个可直接创建并收敛 PR 的 Fast-track 变更。",
      "- 参考 https://example.invalid/review。",
    );
    const output = await renderPlan(plan);
    expect(output).toContain("https&#58;//example.invalid/review");
    expect(output).not.toContain("https://example.invalid/review");
  });
});
