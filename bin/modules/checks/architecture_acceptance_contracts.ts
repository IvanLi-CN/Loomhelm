import {
  CURRENT_REVIEW_DISPOSITIONS,
  EMPIRICAL_ACCEPTANCE_REQUIRED_PHRASES,
  EMPIRICAL_ACCEPTANCE_SPEC,
  REVIEW_ANCHOR_CONTRACTS,
  RETIRED_REVIEW_DISPOSITIONS,
} from "./architecture_contract_data";
import {
  existsFile,
  has,
  missingPhrases,
  operational,
  pathFor,
} from "./architecture_contract_helpers";

export function checkEmpiricalAcceptance(root: string): string[] {
  const findings: string[] = [];
  const reference =
    "skills/project-engineering-workflow/references/empirical-acceptance-short-contract.md";
  if (!existsFile(pathFor(root, reference)))
    findings.push(`EMPIRICAL_ACCEPTANCE_REFERENCE_MISSING path=${reference}`);
  else {
    const source = readFileSync(pathFor(root, reference), "utf8").toLowerCase();
    missingPhrases(
      findings,
      "EMPIRICAL_ACCEPTANCE_CONTRACT_MISSING",
      source,
      EMPIRICAL_ACCEPTANCE_REQUIRED_PHRASES,
    );
  }
  const consumers = {
    workflow: "skills/project-engineering-workflow/SKILL.md",
    "canonical-reference":
      "skills/project-engineering-workflow/references/review-proof-short-contract.md",
    "fast-flow": "skills/fast-flow/SKILL.md",
    "local-merge-flow": "skills/local-merge-flow/SKILL.md",
    "normal-flow": "skills/normal-flow/SKILL.md",
    "flow-continue": "skills/flow-continue/SKILL.md",
    "dev-plan": "skills/dev-plan/SKILL.md",
  } as const;
  for (const [owner, relativePath] of Object.entries(consumers)) {
    if (!existsFile(pathFor(root, relativePath))) {
      findings.push(`EMPIRICAL_ACCEPTANCE_CONSUMER_MISSING owner=${owner}`);
      continue;
    }
    const source = operational(root, relativePath);
    if (
      !source.includes("empirical_acceptance") &&
      !source.includes("empirical acceptance")
    )
      findings.push(`EMPIRICAL_ACCEPTANCE_CONSUMER_MISSING owner=${owner}`);
    if (
      owner !== "dev-plan" &&
      !source.includes("diagnosis-only") &&
      !source.includes("diagnosis only")
    )
      findings.push(
        `EMPIRICAL_ACCEPTANCE_REGRESSION_RULE_MISSING owner=${owner}`,
      );
  }
  const [specRelative, required] = EMPIRICAL_ACCEPTANCE_SPEC;
  if (!existsFile(pathFor(root, specRelative)))
    findings.push(`EMPIRICAL_ACCEPTANCE_SPEC_MISSING path=${specRelative}`);
  else
    missingPhrases(
      findings,
      "EMPIRICAL_ACCEPTANCE_SPEC_CONTRACT_MISSING",
      operational(root, specRelative),
      required,
    );
  return findings;
}

export function checkAnchorsAndContext(root: string): string[] {
  const findings: string[] = [];
  for (const [
    owner,
    relativePath,
    marker,
    endMarker,
    fields,
  ] of REVIEW_ANCHOR_CONTRACTS) {
    if (!existsFile(pathFor(root, relativePath))) {
      findings.push(
        `REVIEW_ANCHOR_CONTRACT_MISSING owner=${owner} path=${relativePath}`,
      );
      continue;
    }
    const source = operational(root, relativePath);
    const start = source.indexOf(marker.toLowerCase());
    if (start < 0) {
      findings.push(
        `REVIEW_ANCHOR_CONTRACT_MISSING owner=${owner} marker=${marker}`,
      );
      continue;
    }
    const end = source.indexOf(endMarker.toLowerCase(), start + marker.length);
    if (end < 0) {
      findings.push(
        `REVIEW_ANCHOR_CONTRACT_MISSING owner=${owner} end_marker=${endMarker}`,
      );
      continue;
    }
    const anchor = source.slice(start, end);
    for (const field of fields)
      if (!has(anchor, field))
        findings.push(
          `REVIEW_ANCHOR_CONTRACT_MISSING owner=${owner} field=${field}`,
        );
  }
  const contextPath = "CONTEXT.md";
  if (!existsFile(pathFor(root, contextPath)))
    findings.push(`REVIEW_CONTEXT_MISSING path=${contextPath}`);
  else {
    const source = operational(root, contextPath);
    for (const disposition of CURRENT_REVIEW_DISPOSITIONS)
      if (!has(source, disposition))
        findings.push(
          `REVIEW_CONTEXT_DISPOSITION_MISSING disposition=${disposition}`,
        );
    for (const disposition of RETIRED_REVIEW_DISPOSITIONS)
      if (has(source, disposition))
        findings.push(
          `REVIEW_CONTEXT_RETIRED_DISPOSITION_PRESENT disposition=${disposition}`,
        );
    for (const phrase of [
      "design decision stop",
      "two independent formal lanes",
    ])
      if (has(source, phrase))
        findings.push(
          `REVIEW_CONTEXT_LEGACY_DESIGN_GATE_PRESENT phrase=${phrase}`,
        );
  }
  return findings;
}
import { readFileSync } from "node:fs";
