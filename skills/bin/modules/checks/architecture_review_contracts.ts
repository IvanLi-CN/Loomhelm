import {
  CANONICAL_REVIEW_REFERENCE,
  CONVERGENCE_BOUNDARY_CONTRACTS,
  CURRENT_REVIEW_DISPOSITIONS,
  PR_STAGE_PARALLEL_CONTRACTS,
  PR_STAGE_SERIAL_GATE_FORBIDDEN,
  RELEASE_PLANNING_REQUIRED_PHRASES,
  REVIEW_CONSUMER_RELATIVE_PATHS,
  REVIEW_READINESS_CONTRACTS,
  REVIEW_READINESS_REQUIRED_PHRASES,
  RETIRED_REVIEW_DISPOSITIONS,
} from "./architecture_contract_data";
import {
  existsFile,
  has,
  missingPhrases,
  operational,
  pathFor,
  serial,
} from "./architecture_contract_helpers";
import { EMPIRICAL_ACCEPTANCE_REFERENCE } from "./architecture_contract_data";

export function checkConvergenceBoundaries(root: string): string[] {
  const findings: string[] = [];
  for (const [relativePath, rules] of Object.entries(
    CONVERGENCE_BOUNDARY_CONTRACTS,
  )) {
    const source = operational(root, relativePath);
    for (const [rule, pattern] of Object.entries(rules))
      if (!new RegExp(pattern, "i").test(source))
        findings.push(
          `CONVERGENCE_BOUNDARY_MISSING owner=${relativePath} rule=${rule}`,
        );
  }
  return findings;
}

function checkReleasePlanning(root: string, findings: string[]): void {
  const reference =
    "skills/project-engineering-workflow/references/release-planning-short-contract.md";
  const source = operational(root, reference);
  if (!existsFile(pathFor(root, reference)))
    findings.push(`RELEASE_PLANNING_CONTRACT_MISSING path=${reference}`);
  else
    missingPhrases(
      findings,
      "RELEASE_PLANNING_CONTRACT_MISSING",
      source,
      RELEASE_PLANNING_REQUIRED_PHRASES,
    );
  const consumers = {
    "dev-plan": [
      "skills/dev-plan/SKILL.md",
      EMPIRICAL_ACCEPTANCE_REFERENCE.replace(
        "empirical-acceptance",
        "release-planning",
      ),
      "decision card",
      "existing `Flow Decision`",
    ],
    workflow: [
      "skills/project-engineering-workflow/SKILL.md",
      "release-planning-short-contract.md",
      "target repository policy",
      "decision card",
    ],
    "flow-continue": [
      "skills/flow-continue/SKILL.md",
      "release-planning-short-contract.md",
      "runtime release decision card",
      "post-merge contract",
    ],
  } as const;
  for (const [owner, values] of Object.entries(consumers)) {
    const [relativePath, ...phrases] = values;
    const content = operational(root, relativePath!);
    if (!existsFile(pathFor(root, relativePath!))) {
      findings.push(`RELEASE_PLANNING_CONSUMER_MISSING owner=${owner}`);
      continue;
    }
    for (const phrase of phrases)
      if (!has(content, phrase))
        findings.push(
          `RELEASE_PLANNING_CONSUMER_MISSING owner=${owner} phrase=${phrase}`,
        );
  }
}

function checkPrWorkflow(root: string, findings: string[]): void {
  const contracts: Record<string, [string, readonly string[]]> = {
    workflow: [
      "skills/project-engineering-workflow/SKILL.md",
      [
        "pr-publication-procedure.md",
        "pr-merge-procedure.md",
        "step 5",
        "step 6",
        "tier 1..4",
      ],
    ],
    "publication-procedure": [
      "skills/project-engineering-workflow/references/pr-publication-procedure.md",
      [
        "operation envelope",
        "mode=draft-bootstrap",
        "custom_notes",
        "exact current head",
        "expected_head_sha",
        "expected_base_sha",
        "role metadata",
      ],
    ],
    "merge-procedure": [
      "skills/project-engineering-workflow/references/pr-merge-procedure.md",
      [
        "operation envelope",
        "mode=post-merge",
        "merge_method=merge|squash|rebase",
        "expected_head_sha",
        "remote",
        "head_repository",
        "delete",
        "delete `404`",
        "http `404`",
        "base_alignment_helper.ts",
        "apply-auto",
        "--refresh-remote",
        "state=aligned",
        "merge-only",
        "do not run `merge_preflight.ts` or `code_hosting.ts pr-merge",
      ],
    ],
    "fast-flow": ["skills/fast-flow/SKILL.md", ["tier 1..4", "tier 3"]],
    "local-merge-flow": [
      "skills/local-merge-flow/SKILL.md",
      ["tier 1..4 review necessity assessment"],
    ],
  };
  for (const [owner, [relativePath, phrases]] of Object.entries(contracts))
    missingPhrases(
      findings,
      `PR_WORKFLOW_CONTRACT_MISSING owner=${owner}`,
      operational(root, relativePath),
      phrases,
    );
}

function checkCanonicalReview(root: string, findings: string[]): void {
  const reference =
    "skills/project-engineering-workflow/references/review-proof-short-contract.md";
  const source = operational(root, reference);
  if (!existsFile(pathFor(root, reference))) {
    findings.push("CANONICAL_REVIEW_REFERENCE_MISSING");
    return;
  }
  for (const disposition of CURRENT_REVIEW_DISPOSITIONS)
    if (!has(source, disposition))
      findings.push(
        `CANONICAL_REVIEW_DISPOSITION_MISSING disposition=${disposition}`,
      );
  for (const disposition of RETIRED_REVIEW_DISPOSITIONS)
    if (has(source, disposition))
      findings.push(
        `CANONICAL_REVIEW_RETIRED_DISPOSITION_PRESENT disposition=${disposition}`,
      );
  missingPhrases(findings, "DIRECT_REVIEW_CONTRACT_MISSING", source, [
    "no `flow_receipt.ts` command",
    "no concurrency limit",
    "unknown scope",
    "base drift",
    "repo_root",
    "unchecked",
    "owner authorization",
  ]);
  const execution = operational(
    root,
    "skills/project-engineering-workflow/references/execution-receipt-short-contract.md",
  );
  missingPhrases(findings, "REVIEW_LEDGER_DECOUPLING_MISSING", execution, [
    "review execution and review gates never depend on this ledger",
    "require this audit metadata",
  ]);
}

function checkReviewConsumers(root: string, findings: string[]): void {
  for (const [owner, relativePath] of REVIEW_CONSUMER_RELATIVE_PATHS) {
    const path = pathFor(root, relativePath);
    if (!existsFile(path)) {
      findings.push(`DIRECT_REVIEW_CONSUMER_MISSING consumer=${owner}`);
      continue;
    }
    const source = operational(root, relativePath);
    if (
      owner !== "canonical-reference" &&
      !has(source, CANONICAL_REVIEW_REFERENCE)
    )
      findings.push(
        `DIRECT_REVIEW_REFERENCE_MISSING consumer=${owner} reference=${CANONICAL_REVIEW_REFERENCE}`,
      );
    for (const disposition of CURRENT_REVIEW_DISPOSITIONS)
      if (!has(source, disposition))
        findings.push(
          `DIRECT_REVIEW_DISPOSITION_MISSING consumer=${owner} disposition=${disposition}`,
        );
    for (const disposition of RETIRED_REVIEW_DISPOSITIONS)
      if (has(source, disposition))
        findings.push(
          `DIRECT_REVIEW_RETIRED_DISPOSITION_PRESENT consumer=${owner} disposition=${disposition}`,
        );
  }
  for (const [owner, relativePath] of [
    ["workflow", "skills/project-engineering-workflow/SKILL.md"],
    ["fast-flow", "skills/fast-flow/SKILL.md"],
    ["local-merge-flow", "skills/local-merge-flow/SKILL.md"],
    ["flow-continue", "skills/flow-continue/SKILL.md"],
  ] as const)
    for (const token of [
      "review-assess",
      "review-wave",
      "review-freeze",
      "reviewreceipt",
    ])
      if (has(operational(root, relativePath), token))
        findings.push(
          `REVIEW_LEDGER_COUPLING_PRESENT skill=${owner} token=${token}`,
        );
}

function checkReviewReadiness(root: string, findings: string[]): void {
  for (const [owner, relatives] of Object.entries(REVIEW_READINESS_CONTRACTS))
    for (const relativePath of relatives) {
      if (!existsFile(pathFor(root, relativePath))) {
        findings.push(
          `REVIEW_READINESS_CONTRACT_MISSING owner=${owner} path=${relativePath}`,
        );
        continue;
      }
      missingPhrases(
        findings,
        `REVIEW_READINESS_CONTRACT_MISSING owner=${owner}`,
        operational(root, relativePath),
        REVIEW_READINESS_REQUIRED_PHRASES,
      );
    }
}

function checkPrStage(root: string, findings: string[]): void {
  for (const [owner, values] of Object.entries(PR_STAGE_PARALLEL_CONTRACTS)) {
    const relativePath = values[0] as string;
    const required = values[1] as readonly string[];
    if (!existsFile(pathFor(root, relativePath))) {
      findings.push(
        `PR_STAGE_PARALLEL_CONTRACT_MISSING owner=${owner} path=${relativePath}`,
      );
      continue;
    }
    missingPhrases(
      findings,
      `PR_STAGE_PARALLEL_CONTRACT_MISSING owner=${owner}`,
      operational(root, relativePath),
      required,
    );
  }
  for (const [owner, forbidden] of Object.entries(
    PR_STAGE_SERIAL_GATE_FORBIDDEN,
  )) {
    const relativePath = (
      PR_STAGE_PARALLEL_CONTRACTS as Record<string, readonly unknown[]>
    )[owner]![0] as string;
    for (const phrase of forbidden)
      if (has(serial(root, relativePath), phrase))
        findings.push(
          `PR_STAGE_SERIAL_GATE_PRESENT owner=${owner} phrase=${phrase}`,
        );
  }
}

export function checkReviewContracts(root: string): string[] {
  const findings: string[] = [];
  checkReleasePlanning(root, findings);
  checkPrWorkflow(root, findings);
  checkCanonicalReview(root, findings);
  checkReviewConsumers(root, findings);
  checkReviewReadiness(root, findings);
  checkPrStage(root, findings);
  return findings;
}
