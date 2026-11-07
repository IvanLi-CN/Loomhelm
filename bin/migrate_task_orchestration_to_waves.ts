import { runCompatibilityCli } from "./compatibility_cli";

if (import.meta.main)
  process.exitCode = await runCompatibilityCli(
    "migrate_task_orchestration_to_waves",
  );
