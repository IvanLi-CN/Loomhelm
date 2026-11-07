import { existsSync } from "node:fs";
import { join } from "node:path";
import { ACTIVE_REVIEW_SPEC_CONTRACTS } from "./architecture_contract_data";
import { currentOperationalContractText } from "./architecture_markdown";

const has = (source: string, phrase: string): boolean =>
  source.includes(phrase.toLowerCase());

function missing(
  findings: string[],
  prefix: string,
  source: string,
  phrases: readonly string[],
): void {
  for (const phrase of phrases)
    if (!has(source, phrase)) findings.push(`${prefix} phrase=${phrase}`);
}

export function checkActiveSpecsAndImplementations(root: string): string[] {
  const findings: string[] = [];
  for (const [name, values] of Object.entries(ACTIVE_REVIEW_SPEC_CONTRACTS)) {
    const relativePath = values[0] as string;
    const required = values[1] as readonly string[];
    const forbidden = values[2] as readonly string[];
    const path = join(root, relativePath);
    if (!existsSync(path)) {
      findings.push(`ACTIVE_REVIEW_SPEC_MISSING spec=${name}`);
      continue;
    }
    const source = currentOperationalContractText(path);
    missing(
      findings,
      `ACTIVE_REVIEW_SPEC_CONTRACT_MISSING spec=${name}`,
      source,
      required,
    );
    for (const phrase of forbidden)
      if (has(source, phrase))
        findings.push(
          `ACTIVE_REVIEW_SPEC_LEGACY_GATE_PRESENT spec=${name} phrase=${phrase}`,
        );
  }
  const implementations = {
    "pr-convergence-batching": [
      "docs/specs/pr-convergence-batching/IMPLEMENTATION.md",
      ["Current convergence", "Formal Review Wave", "Repair Batch"],
      [
        "每个 epoch 最多三次 repair permit",
        "final merge proof 的 blocker 回到剩余 permit",
      ],
    ],
    "flow-continue-lock-guard": [
      "docs/specs/flow-continue-lock-guard/IMPLEMENTATION.md",
      ["Current convergence", "ordinary convergence"],
      ["Permit recovery: checker", "receipt rebind 保持"],
    ],
  } as const;
  for (const [name, values] of Object.entries(implementations)) {
    const relativePath = values[0];
    const path = join(root, relativePath);
    if (!existsSync(path)) {
      findings.push(`ACTIVE_REVIEW_IMPLEMENTATION_MISSING spec=${name}`);
      continue;
    }
    const source = currentOperationalContractText(path);
    missing(
      findings,
      `ACTIVE_REVIEW_IMPLEMENTATION_CONTRACT_MISSING spec=${name}`,
      source,
      values[1],
    );
    for (const phrase of values[2])
      if (has(source, phrase))
        findings.push(
          `ACTIVE_REVIEW_IMPLEMENTATION_LEGACY_GATE_PRESENT spec=${name} phrase=${phrase}`,
        );
  }
  return findings;
}
