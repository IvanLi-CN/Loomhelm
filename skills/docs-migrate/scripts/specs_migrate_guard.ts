import { runCompatibilityCli } from "../../bin/compatibility_cli";

if (import.meta.main)
  process.exitCode = await runCompatibilityCli("specs_migrate_guard");
