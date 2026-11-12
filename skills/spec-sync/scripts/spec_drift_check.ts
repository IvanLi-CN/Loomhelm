import { runCompatibilityCli } from "./_runtime/compatibility_cli";

if (import.meta.main)
  process.exitCode = await runCompatibilityCli("spec_drift_check");
