import { witness, type Witness } from "./domain-witness-types";

const profile: Witness[] = [
  witness(
    "bin/tests/flow/profile.test.ts",
    "profile directives persist as compact canonical state and gate launches",
    "directive and launch gate",
    ["directive", "launch", "model"],
  ),
  witness(
    "bin/tests/flow/profile.test.ts",
    "profile fallback blockers and event identity parsing fail closed",
    "fallback blockers and event identity",
    ["fallback", "block", "event", "identity", "invalid"],
  ),
  witness(
    "bin/tests/flow/profile.test.ts",
    "fallback permits are keyed by the canonical logical identity",
    "fallback permit identity",
    ["permit", "fallback", "logical", "identity"],
  ),
  witness(
    "bin/tests/flow/profile.test.ts",
    "hook state can be redirected without changing the process environment",
    "hook state isolation",
    ["hook", "environment", "redirect"],
  ),
  witness(
    "bin/tests/flow/profile.test.ts",
    "native attestation derives a direct profile resolution",
    "native profile attestation",
    ["attest", "profile", "resolution", "native"],
  ),
];

export const DOMAIN_WITNESSES_A: Record<string, Witness[]> = {
  "bin/test_agent_profile_runtime.py": profile,
  "bin/test_agent_profiles.py": profile,
  "bin/test_agent_vm_migration_check.py": [
    witness(
      "bin/tests/checks/agent_vm.test.ts",
      "active files report the missing external Agent VM index rows",
      "baseline external Agent VM index gap",
      ["agent", "vm", "route", "retired"],
    ),
  ],
  "bin/test_code_hosting.py": [
    witness(
      "bin/tests/hosting/hosting.test.ts",
      "supported remote forms resolve to one canonical identity",
      "canonical provider identity",
      ["remote", "identity", "repository", "canonical"],
    ),
    witness(
      "bin/tests/hosting/hosting.test.ts",
      "asset URLs are provider-specific and pinned to a revision",
      "provider asset revision binding",
      ["asset", "revision", "url", "provider"],
    ),
    witness(
      "bin/tests/hosting/hosting.test.ts",
      "provider evidence redacts secret fields and URL credentials",
      "provider evidence redaction",
      ["secret", "credential", "redact", "evidence"],
    ),
    witness(
      "bin/tests/hosting/hosting.test.ts",
      "provider commands stay repository-bound and forward JSON bodies",
      "repository-bound provider command",
      ["command", "repository", "json", "body"],
    ),
  ],
  "bin/test_create_reg_cli_report.py": [
    witness(
      "bin/tests/visual/visual.test.ts",
      "report creation and audit keep inputs symlinked and outputs independent",
      "report artifact isolation",
      ["report", "output", "input", "artifact", "isolate"],
    ),
    witness(
      "bin/tests/visual/visual.test.ts",
      "sandbox logs reject pre-created symlinks without writing through them",
      "sandbox symlink protection",
      ["sandbox", "symlink", "write", "reject"],
    ),
    witness(
      "bin/native-tests/visual/native.test.ts",
      "atomic publication rename never replaces an existing destination",
      "atomic report publication",
      ["publication", "rename", "destination", "collision"],
    ),
    witness(
      "bin/tests/visual/visual.test.ts",
      "comparison reports transparent pixel changes and same-path current-only state",
      "report comparison facts",
      ["comparison", "pixel", "diff", "current"],
    ),
  ],
  "bin/test_dot_codex_context.py": [
    witness(
      "bin/tests/workspace/workspace.test.ts",
      "allows a linked candidate only with the matching runtime repository",
      "candidate runtime binding",
      ["linked", "runtime", "repository", "candidate"],
    ),
    witness(
      "bin/tests/workspace/workspace.test.ts",
      "removes runtime and Git context from fixed checks",
      "fixed-check environment sanitization",
      ["git", "context", "environment", "home"],
    ),
    witness(
      "bin/tests/workspace/workspace.test.ts",
      "stops fixed validation at the first failing entrypoint",
      "fixed validation stop",
      ["validation", "failing", "entrypoint", "stop"],
    ),
  ],
  "bin/test_flow_continue_replay_check.py": [
    witness(
      "bin/tests/checks/checks.test.ts",
      "historical flow replay guards lock drift and Python route parity",
      "historical flow replay guard",
      ["flow", "replay", "route", "drift", "lock"],
    ),
    witness(
      "bin/tests/plan/review.test.ts",
      "preserves wave-thread routing under Python whitespace rules",
      "flow routing normalization",
      ["route", "routing", "whitespace", "flow"],
    ),
  ],
  "bin/test_flow_receipt.py": [
    witness(
      "bin/tests/flow/flow.test.ts",
      "canonical JSON and hashes match the Python contract",
      "flow receipt canonical identity",
      ["json", "hash", "canonical", "identity"],
    ),
    witness(
      "bin/tests/flow/flow.test.ts",
      "terminal sealing archives immutable state and is idempotent",
      "flow terminal sealing",
      ["close", "seal", "terminal", "archive", "idempotent"],
    ),
    witness(
      "bin/tests/flow/flow.test.ts",
      "acceptance evidence binds candidate and deployment identities",
      "acceptance identity binding",
      ["acceptance", "candidate", "deployment", "identity"],
    ),
    witness(
      "bin/tests/flow/flow.test.ts",
      "current-head attestation only reuses a receipt for an equivalent delta",
      "current-head receipt freshness",
      ["head", "receipt", "stale", "fresh", "delta"],
    ),
    witness(
      "bin/tests/checks/flow_release.test.ts",
      "rejects unbound and stale release evidence",
      "release evidence binding",
      ["release", "stale", "unbound", "evidence"],
    ),
  ],
  "bin/test_instruction_architecture_check.py": [
    witness(
      "bin/tests/checks/checks.test.ts",
      "current instruction architecture and skills index are clean",
      "instruction architecture contract",
      ["instruction", "architecture", "skill", "index"],
    ),
  ],
  "bin/test_instruction_behavior_replay.py": [
    witness(
      "bin/tests/checks/checks.test.ts",
      "behavior score and instruction snapshots preserve strict fields",
      "instruction behavior score contract",
      ["behavior", "instruction", "score", "field"],
    ),
  ],
  "bin/test_owner_facing_image_gate.py": [
    witness(
      "bin/tests/visual/visual.test.ts",
      "owner-facing gate accepts snapshots and rejects remote, relative, and missing links",
      "owner-facing image gate",
      ["owner", "snapshot", "remote", "relative", "missing"],
    ),
    witness(
      "bin/tests/visual/visual.test.ts",
      "snapshots are unique, immutable, and ASCII-safe",
      "snapshot identity and path safety",
      ["snapshot", "unique", "immutable", "ascii"],
    ),
  ],
  "bin/test_plan_acceptance_manifest.py": [
    witness(
      "bin/tests/plan/acceptance.test.ts",
      "normalizes strict entries and defaults the validation gate",
      "acceptance entry normalization",
      ["normalize", "default", "gate"],
    ),
    witness(
      "bin/tests/plan/acceptance.test.ts",
      "requires direct evidence for high-risk acceptance",
      "high-risk acceptance evidence",
      ["high-risk", "risk", "evidence"],
    ),
    witness(
      "bin/tests/plan/acceptance.test.ts",
      "checks concrete empirical assertions",
      "empirical acceptance assertions",
      ["empirical", "assertion", "concrete"],
    ),
    witness(
      "bin/tests/plan/acceptance.test.ts",
      "requires explicit direct and multi-task-flow phase bindings",
      "acceptance phase binding",
      ["phase", "direct", "wave", "binding"],
    ),
  ],
  "bin/test_plan_contract_check.py": [
    witness(
      "bin/tests/plan/shell.test.ts",
      "keeps raw-plan diagnostics through Bun without invoking Python",
      "plan shell diagnostics",
      ["raw", "diagnostic", "python", "shell"],
    ),
    witness(
      "bin/tests/plan/shell.test.ts",
      "preserves standalone CLI cwd paths and argparse exit codes",
      "plan CLI argument and exit parity",
      ["cli", "argument", "exit", "cwd"],
    ),
    witness(
      "bin/tests/plan/acceptance.test.ts",
      "requires explicit direct and multi-task-flow phase bindings",
      "plan acceptance phase contract",
      ["acceptance", "phase", "direct", "wave"],
    ),
    witness(
      "bin/tests/plan/orchestration.test.ts",
      "rejects malformed active multi-task topology, metadata, and nesting",
      "plan topology contract",
      ["topology", "metadata", "nest", "malformed"],
    ),
  ],
  "bin/test_plan_review_view.py": [
    witness(
      "bin/tests/plan/review.test.ts",
      "renders the current multi-task fixture with nine owner-facing sections",
      "plan review projection",
      ["projection", "owner", "wave", "final"],
    ),
    witness(
      "bin/tests/plan/shell.test.ts",
      "rejects a candidate entrypoint with a symlinked parent",
      "plan candidate path safety",
      ["symlink", "path", "candidate", "reject"],
    ),
    witness(
      "bin/tests/plan/launcher_race.test.ts",
      "cleans up INT and TERM on first launcher directory appearance",
      "plan launcher cleanup race",
      ["launcher", "signal", "cleanup", "race"],
    ),
  ],
};
