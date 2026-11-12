import { runCompatibilityCli } from "./_runtime/compatibility_cli";

if (import.meta.main)
  process.exitCode = await runCompatibilityCli("specs_migrate_guard");
