import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkReviewContracts, checkConvergenceBoundaries } from "../../modules/checks/architecture_review_contracts";

const relative = "skills/project-engineering-workflow/references/review-proof-short-contract.md";
const source = readFileSync(resolve(import.meta.dir, "../../../..", relative), "utf8");
const requirements = {
  "comprehensive-default": "Tier 3: one comprehensive read-only reviewer",
  "specialist-risk": "record each selected lane's concrete risk and scope",
  "fresh-round": "Every new formal review round launches a fresh, isolated reviewer",
  "full-diff-repair": "reviewing the complete current diff",
  "dimension-evidence": "dimensions are not separate reviewers or independent review evidence",
};

test("review policy guards reject loss of coverage, independence, and refresh obligations", () => {
  const directory = mkdtempSync(join(tmpdir(), "comprehensive-review-policy-"));
  const target = join(directory, relative);
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(target, source);
    for (const rule of Object.keys(requirements)) {
      expect(checkConvergenceBoundaries(directory).some((finding) => finding.endsWith(`rule=${rule}`))).toBe(false);
    }
    expect(checkReviewContracts(directory).filter((finding) => finding.startsWith("DIRECT_REVIEW_CONTRACT_MISSING"))).toEqual([]);
    writeFileSync(target, source.replace("`gpt-5.6-luna + medium`", "removed profile"));
    expect(checkReviewContracts(directory)).toContain("DIRECT_REVIEW_CONTRACT_MISSING phrase=gpt-5.6-luna + medium");
    for (const [rule, phrase] of Object.entries(requirements)) {
      writeFileSync(target, source.replace(phrase, "removed requirement"));
      expect(checkConvergenceBoundaries(directory)).toContain(`CONVERGENCE_BOUNDARY_MISSING owner=${relative} rule=${rule}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
