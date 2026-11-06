import { basename } from "node:path";

const replayCases: Record<string, string> = {
  active_long_task_replay_check:
    "docs/specs/active-long-task-ownership-wait-guard/replay/cases.txt",
  browser_policy_replay_check:
    "docs/specs/gn7xq-gui-escalation-gate/replay/cases.txt",
  flow_continue_replay_check:
    "docs/specs/flow-continue-lock-guard/replay/cases.txt",
  pr_skill_replay_check:
    "docs/specs/pr-skill-diagnosis-thinning/replay/cases.txt",
  release_tracking_replay_check: "docs/specs/release-tracking/replay/cases.txt",
  review_proof_replay_check:
    "docs/specs/review-proof-dedupe-wait-guard/replay/cases.txt",
  visual_evidence_replay_check:
    "docs/specs/shared-ui-visual-evidence-gate/replay/cases.txt",
};

const compatibilityWrappers = new Set([
  "active_long_task_replay_check",
  "agent_vm_migration_check",
  "browser_policy_replay_check",
  "code_hosting",
  "create_reg_cli_report",
  "flow_continue_replay_check",
  "instruction_architecture_check",
  "instruction_behavior_replay",
  "migrate_task_orchestration_to_waves",
  "owner_facing_image_gate",
  "pr_body_image_contract_check",
  "pr_skill_replay_check",
  "release_tracking_replay_check",
  "review_proof_replay_check",
  "skills_index_check",
  "snapshot_local_image",
  "spec_contract_check",
  "visual_evidence_document",
  "visual_evidence_replay_check",
  "wave_thread_flow",
  "wave_thread_route_audit",
]);

export function entrypointSmokeArgs(replacement: string): string[] {
  if (!replacement.startsWith("bin/")) return ["--help"];
  const name = basename(replacement).replace(/\.ts$/, "");
  if (!compatibilityWrappers.has(name)) return ["--help"];
  const smoke = "--compatibility-smoke";
  if (name === "flow_continue_replay_check")
    return ["bin/fixtures/python-compatibility/flow-smoke-cases.txt", smoke];
  if (replayCases[name]) return [replayCases[name], smoke];
  if (name === "code_hosting" || name === "create_reg_cli_report")
    return ["--help", smoke];
  if (
    name === "instruction_architecture_check" ||
    name === "skills_index_check"
  )
    return ["--repo-root", ".", smoke];
  if (name === "agent_vm_migration_check" || name === "wave_thread_route_audit")
    return ["--repo-root", ".", smoke];
  if (name === "pr_body_image_contract_check")
    return ["--cases", "skills/ui-visual-evidence/replay/cases.json", smoke];
  if (name === "spec_contract_check")
    return [
      "--path",
      "docs/specs/bun-typescript-scripts/SPEC.md",
      "--repo-root",
      ".",
      smoke,
    ];
  if (name === "instruction_behavior_replay" || name === "snapshot_local_image")
    return ["--help", smoke];
  if (name === "visual_evidence_document" || name === "wave_thread_flow")
    return ["--help", smoke];
  return [smoke];
}

export function entrypointCommand(replacement: string): string {
  const args = entrypointSmokeArgs(replacement);
  if (args[0] === "--help" && !args.includes("--compatibility-smoke"))
    return `bun ${replacement} --help`;
  return `bun ${replacement} ${args.join(" ")}`;
}

export function isCompatibilityWrapper(replacement: string): boolean {
  return (
    replacement.startsWith("bin/") &&
    compatibilityWrappers.has(basename(replacement).replace(/\.ts$/, ""))
  );
}
