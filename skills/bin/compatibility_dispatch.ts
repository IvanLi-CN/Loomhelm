import {
  analyzeActiveLongTask,
  analyzeBrowserReplay,
  analyzeBrowserPolicy,
  analyzeHistoricalReplay,
  analyzePrReplay,
  analyzeReleaseTracking,
  analyzeReviewProof,
  analyzeVisualReplay,
  checkAgentVmRoutes,
  checkInstructionArchitecture,
  checkSkillsIndex,
  checkSpec,
} from "./modules/checks";
import { docs } from "./compatibility_docs";
import { hosting } from "./compatibility_hosting";
import { runInstructionBehaviorReplay } from "./modules/checks/instruction_behavior";
import { processMigration } from "./modules/plan/task_migration";
import { main as baseAlignment } from "./modules/workspace/base_alignment";
import { workspace } from "./compatibility_workspace";
import {
  option,
  positional,
  printList,
  replay,
  rootFor,
  values,
} from "./compatibility_shared";

const visualCommands = new Set([
  "owner_facing_image_gate",
  "pr_body_image_gate",
  "pr_body_image_contract_check",
  "create_reg_cli_report",
  "compare_visual_evidence",
  "trim_whitespace",
  "snapshot_local_image",
  "visual_evidence_document",
]);
const docCommands = new Set([
  "verify_doc_locks",
  "ingest_mineru_extract",
  "find_next_plan",
  "gen_legacy_spec_id",
  "specs_migrate_guard",
  "spec_drift_check",
]);
const workspaceCommands = new Set([
  "closeout_context",
  "closeout_gate",
  "local_merge_closeout_context",
  "local_merge_closeout_gate",
  "merge_preflight",
  "port_registry",
  "candidate_context",
  "context",
]);

export async function dispatch(name: string, argv: string[]): Promise<number> {
  if (name === "active_long_task_replay_check")
    return replay(argv, analyzeActiveLongTask);
  if (name === "flow_continue_replay_check")
    return replay(argv, (path) => analyzeHistoricalReplay(path, "flow"));
  if (name === "browser_policy_replay_check") {
    let exitCode = 0;
    if (argv.includes("--policy")) {
      const findings = analyzeBrowserPolicy({ repoRoot: rootFor(argv) });
      for (const item of findings)
        console.error(`${item.code}:${item.line}: ${item.message}`);
      if (findings.length) exitCode = 1;
    }
    if (values(argv, "cases").length || positional(argv).length) {
      const replayCode = replay(argv, analyzeBrowserReplay);
      if (replayCode) exitCode = replayCode;
    } else if (!argv.includes("--policy")) {
      console.error("provide --policy, --cases, or replay JSONL paths");
      return 2;
    }
    return exitCode;
  }
  if (name === "pr_skill_replay_check") return replay(argv, analyzePrReplay);
  if (name === "release_tracking_replay_check")
    return replay(argv, analyzeReleaseTracking, "exact");
  if (name === "review_proof_replay_check")
    return replay(argv, analyzeReviewProof);
  if (name === "visual_evidence_replay_check")
    return replay(argv, analyzeVisualReplay, "exact");
  if (name === "instruction_architecture_check")
    return printList(checkInstructionArchitecture({ root: rootFor(argv) }));
  if (name === "skills_index_check")
    return printList(checkSkillsIndex(rootFor(argv)));
  if (name === "agent_vm_migration_check")
    return printList(checkAgentVmRoutes(rootFor(argv)));
  if (name === "spec_contract_check") {
    const paths = values(argv, "path");
    if (!paths.length) {
      console.error("--path is required");
      return 2;
    }
    return printList(
      paths.flatMap((path) =>
        checkSpec(path, rootFor(argv)).map(
          (item) =>
            `${item.path} code=${item.code} msg=${item.message}${item.line ? ` line=${item.line}` : ""}`,
        ),
      ),
    );
  }
  if (name === "code_hosting") return hosting(argv);
  if (visualCommands.has(name)) {
    const { visual } = await import("./compatibility_visual");
    return visual(name, argv);
  }
  if (docCommands.has(name)) return docs(name, argv);
  if (workspaceCommands.has(name))
    return workspace(
      name === "context"
        ? "candidate_context"
        : (name as Parameters<typeof workspace>[0]),
      argv,
    );
  if (name === "base_alignment_helper") {
    return baseAlignment(argv);
  }
  if (name === "instruction_behavior_replay") {
    return runInstructionBehaviorReplay(argv);
  }
  if (name === "migrate_task_orchestration_to_waves") {
    const inPlace = argv.includes("--in-place");
    let exitCode = 0;
    for (const path of positional(argv)) {
      const code = await processMigration(path, inPlace);
      if (code) exitCode = code;
    }
    return exitCode;
  }
  if (name === "context") return workspace("candidate_context", argv);
  return 2;
}
