import { witness, type Witness } from "./domain-witness-types";

export const DOMAIN_WITNESSES_B: Record<string, Witness[]> = {
  "bin/test_pr_skill_replay_check.py": [
    witness(
      "bin/tests/checks/checks.test.ts",
      "historical PR replay keeps merge and diagnosis guards",
      "historical PR replay guard",
      ["pr", "merge", "diagnosis", "guard", "replay"],
    ),
    witness(
      "bin/tests/checks/flow_release.test.ts",
      "accepts a trusted route refresh after continue",
      "trusted PR route refresh",
      ["route", "refresh", "continue", "trusted"],
    ),
  ],
  "bin/test_release_tracking_replay_check.py": [
    witness(
      "bin/tests/checks/checks.test.ts",
      "active-long, browser, and release replay cases preserve verdicts",
      "release replay verdict",
      ["release", "tracking", "replay", "verdict"],
    ),
    witness(
      "bin/tests/checks/flow_release.test.ts",
      "accepts fresh merged proof after a later route refresh",
      "fresh release proof",
      ["fresh", "merged", "proof", "release"],
    ),
  ],
  "bin/test_skills_index_check.py": [
    witness(
      "bin/tests/checks/checks.test.ts",
      "current instruction architecture and skills index are clean",
      "skills index contract",
      ["skill", "index", "architecture"],
    ),
  ],
  "bin/test_snapshot_local_image.py": [
    witness(
      "bin/tests/visual/visual.test.ts",
      "snapshots are unique, immutable, and ASCII-safe",
      "snapshot local image contract",
      ["snapshot", "unique", "immutable", "ascii"],
    ),
  ],
  "bin/test_spec_contract_check.py": [
    witness(
      "bin/tests/docs/contract_migration.test.ts",
      "accepts a complete requirement and verification trace",
      "Spec requirement trace",
      ["requirement", "verification", "trace", "accept"],
    ),
    witness(
      "bin/tests/docs/contract_migration.test.ts",
      "rejects task-state sections, checkboxes, and missing traceability",
      "Spec contract rejection",
      ["reject", "missing", "trace", "checkbox", "task"],
    ),
  ],
  "bin/test_visual_evidence_document.py": [
    witness(
      "bin/tests/visual/visual.test.ts",
      "document migration normalizes legacy evidence and preserves asset paths",
      "visual evidence document migration",
      ["document", "legacy", "asset", "path"],
    ),
  ],
  "bin/test_wave_thread_plan_contract.py": [
    witness(
      "bin/tests/plan/orchestration.test.ts",
      "validates the canonical v2 fixture",
      "wave-thread plan fixture",
      ["v2", "fixture", "canonical", "valid"],
    ),
    witness(
      "bin/tests/plan/orchestration.test.ts",
      "rejects malformed active multi-task topology, metadata, and nesting",
      "wave-thread topology rejection",
      ["topology", "metadata", "nest", "reject"],
    ),
    witness(
      "bin/tests/plan/orchestration.test.ts",
      "keeps acceptance owner scope aligned with orchestration",
      "wave-thread acceptance ownership",
      ["acceptance", "owner", "scope", "orchestration"],
    ),
  ],
  "skills/dev-plan/scripts/test_migrate_task_orchestration.py": [
    witness(
      "bin/tests/plan/task_migration.test.ts",
      "task migration converts legacy assignments with flow skill and fallback profile",
      "task migration legacy assignment",
      ["legacy", "assignment", "fallback", "profile"],
    ),
    witness(
      "bin/tests/plan/task_migration.test.ts",
      "task migration preserves explicit profiles and strips invalid legacy metadata",
      "task migration wave normalization",
      ["wave", "execution", "normalize"],
    ),
  ],
  "skills/docs-migrate/scripts/test_gen_legacy_spec_id.py": [
    witness(
      "bin/tests/docs/contract_migration.test.ts",
      "keeps generation migration-only and avoids existing IDs",
      "legacy Spec ID generation",
      ["id", "generation", "legacy"],
    ),
  ],
  "skills/docs-migrate/scripts/test_specs_migrate_guard.py": [
    witness(
      "bin/tests/docs/contract_migration.test.ts",
      "maps a proven legacy plan and reports inbound links",
      "legacy plan migration guard",
      ["legacy", "plan", "link", "migration"],
    ),
    witness(
      "bin/tests/docs/contract_migration.test.ts",
      "requires a slug and confirmation before hygiene rename",
      "migration rename guard",
      ["slug", "rename", "confirm", "hygiene"],
    ),
  ],
  "skills/find-next-plan/scripts/test_find_next_plan.py": [
    witness(
      "bin/tests/docs/plan_and_hardware.test.ts",
      "falls back from a lifecycle catalog to the legacy plan queue",
      "plan queue fallback",
      ["fallback", "legacy", "plan", "queue"],
    ),
    witness(
      "bin/tests/docs/plan_and_hardware.test.ts",
      "selects partial work before ready work and uses git creation time",
      "next plan ordering",
      ["partial", "ready", "creation", "time", "select"],
    ),
  ],
  "skills/git-cleanup/scripts/test_closeout_context.py": [
    witness(
      "bin/tests/workspace/workspace.test.ts",
      "parses live worktree rows and context facts",
      "closeout context facts",
      ["context", "worktree", "row", "fact"],
    ),
  ],
  "skills/git-cleanup/scripts/test_closeout_gate.py": [
    witness(
      "bin/tests/workspace/workspace.test.ts",
      "accepts complete PR cleanup only when every required state is closed",
      "closeout completion gate",
      ["complete", "cleanup", "required", "closed"],
    ),
    witness(
      "bin/tests/workspace/workspace.test.ts",
      "protects native Worktrees and unresolved port leases",
      "closeout resource protection",
      ["worktree", "port", "lease", "protect"],
    ),
  ],
  "skills/git-cleanup/scripts/test_local_merge_closeout_context.py": [
    witness(
      "bin/tests/workspace/workspace.test.ts",
      "allows unrelated dirty state for local merge and blocks a non-base branch",
      "local merge closeout context",
      ["local", "merge", "dirty", "base"],
    ),
  ],
  "skills/git-cleanup/scripts/test_local_merge_closeout_gate.py": [
    witness(
      "bin/tests/workspace/workspace.test.ts",
      "allows unrelated dirty state for local merge and blocks a non-base branch",
      "local merge closeout gate",
      ["local", "merge", "gate", "base"],
    ),
  ],
  "skills/global-port-manager/scripts/test_port_registry.py": [
    witness(
      "bin/tests/workspace/workspace.test.ts",
      "reuses a scope lease and keeps service offsets in its block",
      "port registry scope lease",
      ["lease", "scope", "service", "offset"],
    ),
    witness(
      "bin/tests/workspace/workspace.test.ts",
      "native flock serializes competing allocations",
      "port registry allocation lock",
      ["lock", "flock", "allocate", "serial"],
    ),
  ],
  "skills/project-engineering-workflow/scripts/test_base_alignment_helper.py": [
    witness(
      "bin/tests/workspace/base_alignment.test.ts",
      "base alignment blocks a linked worktree owner",
      "base alignment ownership",
      ["linked", "worktree", "owner", "block"],
    ),
    witness(
      "bin/tests/workspace/base_alignment.test.ts",
      "base alignment distinguishes safe fast-forward routes",
      "base alignment route selection",
      ["fast-forward", "route", "safe"],
    ),
    witness(
      "bin/tests/workspace/base_alignment.test.ts",
      "base alignment requires owner decisions for dirty or divergent bases",
      "base alignment dirty decision",
      ["dirty", "divergent", "decision", "owner"],
    ),
  ],
  "skills/project-engineering-workflow/scripts/test_merge_preflight.py": [
    witness(
      "bin/tests/workspace/workspace.test.ts",
      "accepts a clean exact head and locks the live head",
      "merge preflight exact head",
      ["clean", "exact", "head", "lock"],
    ),
    witness(
      "bin/tests/workspace/workspace.test.ts",
      "closed PRs and unavailable required reads fail closed",
      "merge preflight fail closed",
      ["closed", "unavailable", "fail", "read"],
    ),
  ],
  "skills/spec-sync/scripts/test_spec_drift_check.py": [
    witness(
      "bin/tests/docs/spec_drift.test.ts",
      "maps a new proven legacy plan to its canonical companion set",
      "Spec companion mapping",
      ["legacy", "canonical", "companion", "map"],
    ),
    witness(
      "bin/tests/docs/spec_drift.test.ts",
      "validates every changed Spec when one implementation sync is requested",
      "Spec implementation sync",
      ["changed", "implementation", "sync", "valid"],
    ),
    witness(
      "bin/tests/docs/spec_drift.test.ts",
      "blocks spec-free runs that touch a Spec",
      "Spec-free drift block",
      ["spec-free", "blocks", "touch"],
    ),
  ],
  "skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py": [
    witness(
      "bin/tests/visual/visual.test.ts",
      "comparison reports transparent pixel changes and same-path current-only state",
      "visual comparison report",
      ["comparison", "pixel", "transparent", "diff"],
    ),
    witness(
      "bin/native-tests/visual/native.test.ts",
      "HTML reports require an exact, duplicate-free comparison set",
      "visual comparison set contract",
      ["html", "comparison", "duplicate", "exact"],
    ),
  ],
  "skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py": [
    witness(
      "bin/tests/visual/visual.test.ts",
      "owner-facing gate accepts snapshots and rejects remote, relative, and missing links",
      "PR body image gate",
      ["pr", "body", "image", "remote", "missing"],
    ),
  ],
  "skills/ui-visual-evidence/scripts/test_trim_whitespace.py": [
    witness(
      "bin/tests/visual/visual.test.ts",
      "trim preserves require_margin blocking and trims uniform page edges",
      "visual whitespace trim",
      ["trim", "margin", "edge", "whitespace"],
    ),
  ],
  "skills/wave-thread-flow/scripts/test_wave_thread_flow.py": [
    witness(
      "bin/tests/waves/waves.test.ts",
      "v1 events are transactional and idempotent by event identity",
      "wave v1 event identity",
      ["event", "idempotent", "transaction", "v1"],
    ),
    witness(
      "bin/tests/waves/waves.test.ts",
      "v1 merge, archive, cleanup, and finalization remain compatible",
      "wave v1 closeout lifecycle",
      ["merge", "archive", "cleanup", "final"],
    ),
    witness(
      "bin/tests/waves/waves_closeout.test.ts",
      "closeout resource receipts remain independently bound and idempotent",
      "wave closeout receipts",
      ["receipt", "closeout", "resource", "idempotent"],
    ),
  ],
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py": [
    witness(
      "bin/tests/waves/waves.test.ts",
      "v2 deferred events replay after the parent advances to their wave",
      "wave v2 deferred replay",
      ["deferred", "replay", "wave", "v2"],
    ),
    witness(
      "bin/tests/waves/waves.test.ts",
      "v2 direct merge milestones require a native final PR receipt",
      "wave v2 direct merge gate",
      ["direct", "merge", "milestone", "receipt"],
    ),
    witness(
      "bin/tests/plan/orchestration.test.ts",
      "keeps acceptance owner scope aligned with orchestration",
      "wave v2 acceptance scope",
      ["acceptance", "scope", "owner"],
    ),
  ],
};
