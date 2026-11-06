export const convergenceBoundaryContracts: Record<
  string,
  Record<string, string>
> = {
  "skills/project-engineering-workflow/SKILL.md": {
    "candidate-freeze":
      "freeze\\b[^.]*\\btracked\\b[^.]*\\bbefore\\b[^.]*\\bvalidation",
    "result-placement":
      "(?:current-sha|sha-bound)\\b[^.]*\\bresults\\b[^.]*\\b(?:active flow evidence|external artifacts)\\b",
    "result-only":
      "result collection\\b[^.]*\\b(?:leaves|keeps)\\b[^.]*candidate\\b[^.]*\\b(?:unchanged|frozen)",
    "live-head-ci": "required ci\\b[^.]*\\blive (?:pr )?head\\b",
  },
  "skills/project-engineering-workflow/references/review-proof-short-contract.md":
    {
      "behavioral-readiness":
        "(?:stateful|concurrent)\\b[^.]*\\b(?:executed|run|passed)\\b[^.]*behavioral (?:validation|tests)\\b[^.]*\\bboundaries\\b",
      "pre-write-count":
        "(?:counts?|records?)\\b[^.;]*\\bbatch\\b[^.;]*\\bbefore\\b[^.;]*\\b(?:repair write|writing repairs)",
      "ci-repair-budget":
        "ci-only\\b[^.]*\\b(?:share|consume)\\b[^.]*\\b(?:count|budget|batch)",
      "cumulative-budget":
        "(?:preserve|retain)\\b[^.]*\\brepair_batches_used\\b[^.]*\\b(?:continuation|compaction)",
      "round-boundary":
        "one review round[^.]*starts\\b[^.]*bound base/head[^.]*ends\\b[^.]*required lane[^.]*terminal[^.]*ci",
      "parent-accounting":
        "parent flow\\b[^.]*\\b(?:counts?|records?)\\b[^.;]*before\\b[^.;]*(?:repair write|writing repairs)",
      "repair-not-review-limit":
        "(?:near|three) (?:three )?batches?\\b[^.]*\\b(?:diagnos|verification|repair)",
    },
  "skills/project-engineering-workflow/references/pr-diagnosis-short-contract.md":
    {
      "freshness-admission":
        "\\bbefore\\b[^.]*\\bci tracking\\b[^.]*\\bformal review\\b[^.]*\\brefresh\\b[^.]*base/head",
      "conflict-first": "(?:dirty|conflicting)\\b[^.]*\\bfirst\\b",
      "preserve-running-round":
        "ordinary target\\b[^.]*behind[^.]*alone does not cancel[^.]*running round",
      "batch-target-changes":
        "round boundary\\b[^.]*accumulated target changes\\b[^.]*once\\b",
      "bounded-integration":
        "repeated target movement\\b[^.]*wait budget\\b[^.]*blocker\\b",
      "original-evidence-identity":
        "old checks\\b[^.]*keep\\b[^.]*original base/head identity",
      "authorization-blocker":
        "\\b(?:fixed target|rewrite authorization)\\b[^.]*\\b(?:immediate blocker|block immediately)\\b",
      "starting-point":
        "starting sha\\b[^.]*\\b(?:alone|only)\\b[^.]*\\b(?:does not|cannot)\\b[^.]*\\b(?:fix|lock)\\b",
    },
};

export const releasePlanningRequired = [
  "decision card",
  "publish applicability",
  "bump rule",
  "predicted version",
  "unknown",
  "merge-sha",
  "release_expected",
] as const;

export const empiricalAcceptanceRequired = [
  "empirical_acceptance=required|not_required",
  "empirical_evidence_status=passed|failed|unavailable|not_required",
  "empirical_candidate_sha",
  "acceptance_contract_digest",
  "scenario_set_digest",
  "empirical regression",
  "diagnosis-only",
] as const;

export const empiricalAcceptanceSpec = [
  "docs/specs/empirical-acceptance-review-gate/SPEC.md",
  [
    "Empirical Acceptance Obligation",
    "Empirical Acceptance Evidence",
    "Empirical Regression",
    "candidate_sha",
    "acceptance_contract_digest",
    "scenario_set_digest",
    "diagnosis-only",
    "Design-Returning",
  ],
] as const;

const reviewDispositions = [
  "In-Scope Review Finding",
  "Design-Returning Review Finding",
  "Review Observation",
] as const;
const reviewAnchors = [
  "repo_root",
  "base SHA",
  "head SHA",
  "lane",
  "scope",
  "review profile",
  "current locked flow",
  "ownership promise",
  "cumulative Repair Batch count",
] as const;
export const reviewSpecCommon = [
  ...reviewDispositions,
  "`unchecked` evidence",
  ...reviewAnchors,
] as const;
export const reviewSpecRetired = [
  "fix-now",
  "decision-needed",
  "design-decision-needed",
  "two independent formal lanes",
] as const;

export const activeReviewSpecs = {
  "mandatory-local-review-proof": [
    "docs/specs/mandatory-local-review-proof/SPEC.md",
    reviewSpecCommon,
    reviewSpecRetired,
  ],
  "pr-convergence-batching": [
    "docs/specs/pr-convergence-batching/SPEC.md",
    [
      ...reviewSpecCommon,
      "Formal Review Wave",
      "Repair Batch",
      "Lane Refresh Set",
      "等待时长不构成 review 失败",
    ],
    [
      ...reviewSpecRetired,
      "每个 review epoch 最多允许",
      "5 分钟` 内没有 check runs",
      "才能创建新 epoch 并重新获得三次 repair permit",
      "final merge proof 是当前 SHA 的单条 lane",
    ],
  ],
  "flow-continue-lock-guard": [
    "docs/specs/flow-continue-lock-guard/SPEC.md",
    [
      ...reviewSpecCommon,
      "historical cleanup",
      "ordinary current-head convergence",
      "locked flow",
    ],
    [
      ...reviewSpecRetired,
      "必须路由到 `$pr-create` 或完整的 `review-wave open --stage repair`",
      "receipt 打开当前 base repair wave",
    ],
  ],
  "workflow-agent-model-selection": [
    "docs/specs/workflow-agent-model-selection/SPEC.md",
    reviewSpecCommon,
    reviewSpecRetired,
  ],
} as const;

export const reviewReadinessRequired = [
  "readiness",
  "approved behavior",
  "acceptance",
  "scope",
  "required contracts",
  "validation",
  "no design decision",
  "visual evidence",
] as const;

export const prStageParallelContracts: Record<string, [string, string[]]> = {
  workflow: [
    "skills/project-engineering-workflow/SKILL.md",
    [
      "step 4 ready",
      "does not require completed pr-stage structured findings or dispositions",
      "exact live pr base/head is bound",
      "ci tracker and fresh pr-stage formal review in the same first round",
      "wait for both to reach terminal state",
      "before finding disposition, any repair batch, or main-agent write, commit, or push",
      "local-merge still completes formal review before step 5l",
    ],
  ],
  "fast-flow": [
    "skills/fast-flow/SKILL.md",
    [
      "step 4 ready",
      "does not require completed pr-stage findings or dispositions",
      "after exact live pr head/base binding",
      "start the ci tracker and pr-stage formal review in parallel in the first round",
      "wait for both terminal states before finding disposition",
      "wait for both terminal states before finding disposition, repair batch, writes, commits, or pushes",
      "local-merge continues formal review before step 5l",
    ],
  ],
  publication: [
    "skills/project-engineering-workflow/references/pr-publication-procedure.md",
    [
      "step 4 readiness and tier/rationale assessment",
      "completed pr-stage formal findings are not required yet for a direct pr path",
      "after exact live pr base/head binding",
      "same first round as required-ci tracking",
      "waits for both to reach terminal state",
      "before convergence writes, finding disposition, or a repair batch",
      "draft-bootstrap",
    ],
  ],
  canonical: [
    "skills/project-engineering-workflow/references/review-proof-short-contract.md",
    [
      "formal lanes launch after exact live pr head/base binding",
      "same first round as the ci tracker",
      "waits for all required lanes and ci to reach terminal state",
      "before disposition, writing, a repair batch, commit, or push",
      "for local-merge, formal lanes complete before step 5l",
    ],
  ],
};

export const prStageSerialForbidden: Record<string, string[]> = {
  workflow: ["for tier 3/4, also prepare current formal review evidence"],
  "fast-flow": ["formal review evidence before pr binding"],
  publication: ["formal review evidence before pr publication"],
  canonical: ["formal review evidence before pr publication"],
};

export const reviewAnchorContracts = [
  [
    "canonical",
    "skills/project-engineering-workflow/references/review-proof-short-contract.md",
    "<!-- review-anchor-contract:canonical:start -->",
    "<!-- review-anchor-contract:canonical:end -->",
    [
      "repo_root",
      "base_sha",
      "head_sha",
      "lane",
      "scope",
      "review_profile",
      "current_locked_flow",
      "ownership_promise",
      "repair_batches_used",
      "empirical_acceptance_rationale",
    ],
  ],
  [
    "mandatory-spec",
    "docs/specs/mandatory-local-review-proof/SPEC.md",
    "<!-- review-anchor-contract:mandatory-spec:start -->",
    "<!-- review-anchor-contract:mandatory-spec:end -->",
    reviewAnchors,
  ],
  [
    "workflow-model-spec",
    "docs/specs/workflow-agent-model-selection/SPEC.md",
    "<!-- review-anchor-contract:workflow-model-spec:start -->",
    "<!-- review-anchor-contract:workflow-model-spec:end -->",
    reviewAnchors,
  ],
  [
    "flow-continue",
    "skills/flow-continue/SKILL.md",
    "<!-- review-anchor-contract:flow-continue:start -->",
    "<!-- review-anchor-contract:flow-continue:end -->",
    [
      "base_sha",
      "head_sha",
      "lane",
      "scope",
      "review_profile",
      "current locked flow",
      "ownership promise",
      "cumulative Repair Batch count",
      "empirical acceptance disposition",
      "rationale",
    ],
  ],
] as const;

export const CANONICAL_REVIEW_REFERENCE = "review-proof-short-contract.md";
export const EMPIRICAL_ACCEPTANCE_REFERENCE =
  "empirical-acceptance-short-contract.md";
export const CURRENT_REVIEW_DISPOSITIONS = [
  "In-Scope Review Finding",
  "Design-Returning Review Finding",
  "Review Observation",
] as const;
export const RETIRED_REVIEW_DISPOSITIONS = [
  "fix-now",
  "decision-needed",
  "design-decision-needed",
] as const;
export const CONVERGENCE_BOUNDARY_CONTRACTS = convergenceBoundaryContracts;
export const RELEASE_PLANNING_REQUIRED_PHRASES = releasePlanningRequired;
export const EMPIRICAL_ACCEPTANCE_REQUIRED_PHRASES =
  empiricalAcceptanceRequired;
export const EMPIRICAL_ACCEPTANCE_SPEC = empiricalAcceptanceSpec;
export const PR_STAGE_PARALLEL_CONTRACTS = Object.fromEntries(
  Object.entries(prStageParallelContracts).map(([key, value]) => [key, value]),
) as Record<string, [string, readonly string[]]>;
export const PR_STAGE_SERIAL_GATE_FORBIDDEN = prStageSerialForbidden;
export const REVIEW_ANCHOR_CONTRACTS = reviewAnchorContracts;
export const REVIEW_CONSUMER_RELATIVE_PATHS = [
  ["workflow", "skills/project-engineering-workflow/SKILL.md"],
  [
    "canonical-reference",
    "skills/project-engineering-workflow/references/review-proof-short-contract.md",
  ],
  [
    "advisory-reference",
    "skills/project-engineering-workflow/references/advisory-review-short-contract.md",
  ],
  ["fast-flow", "skills/fast-flow/SKILL.md"],
  ["local-merge-flow", "skills/local-merge-flow/SKILL.md"],
  ["flow-continue", "skills/flow-continue/SKILL.md"],
] as const;
export const REVIEW_READINESS_CONTRACTS = {
  "canonical-reference": [
    "skills/project-engineering-workflow/references/review-proof-short-contract.md",
  ],
  workflow: ["skills/project-engineering-workflow/SKILL.md"],
  "fast-flow": ["skills/fast-flow/SKILL.md"],
  "local-merge-flow": ["skills/local-merge-flow/SKILL.md"],
  context: ["CONTEXT.md"],
  "mandatory-local-review-proof": [
    "docs/specs/mandatory-local-review-proof/SPEC.md",
  ],
  "pr-convergence-batching": ["docs/specs/pr-convergence-batching/SPEC.md"],
  "workflow-agent-model-selection": [
    "docs/specs/workflow-agent-model-selection/SPEC.md",
  ],
} as const;
export const REVIEW_READINESS_REQUIRED_PHRASES = reviewReadinessRequired;
export const ACTIVE_REVIEW_SPEC_CONTRACTS = activeReviewSpecs;
export const REVIEW_SPEC_COMMON_REQUIREMENTS = reviewSpecCommon;
export const REVIEW_SPEC_RETIRED_TERMS = reviewSpecRetired;
