import { runCompatibilityCli } from "./_runtime/compatibility_cli";

if (import.meta.main)
  process.exitCode = await runCompatibilityCli("find_next_plan");
