import { runCompatibilityCli } from "./compatibility_cli";

if (import.meta.main)
  process.exitCode = await runCompatibilityCli("flow_continue_replay_check");
