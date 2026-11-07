import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeHistoricalReplay } from "../../modules/checks";

const root = resolve(import.meta.dir, "../../../..");
const casesPath = join(
  root,
  "skills/docs/vendor/dot-codex/specs/flow-continue-lock-guard/replay/cases.txt",
);

const flowCases = readFileSync(casesPath, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith("#"))
  .map((line) => join(root, line.trim().split(/\s+/)[1]!));
const oracle = JSON.parse(
  readFileSync(
    join(root, "skills/docs/vendor/dot-codex/specs/flow-continue-lock-guard/replay/python-oracle.json"),
    "utf8",
  ),
) as {
  source: string;
  cases: Array<{ path: string; finding_codes: string[] }>;
};

describe("flow replay compatibility", () => {
  test("matches every locked Python oracle classification", () => {
    expect(oracle.source).toBe("18932caa0fedc34725d3f1d99462a063d87b4599");
    expect(oracle.cases).toHaveLength(flowCases.length);
    for (const item of oracle.cases) {
      const actual = [
        ...new Set(
          analyzeHistoricalReplay(join(root, item.path.replace(/^docs\//, "skills/docs/vendor/dot-codex/")), "flow").findings.map(
            (finding) => finding.code,
          ),
        ),
      ].sort();
      expect(actual).toEqual([...item.finding_codes].sort());
    }
  });
});
