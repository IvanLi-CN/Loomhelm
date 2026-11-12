import { runCompatibilityCli } from "./_runtime/compatibility_cli";

if (import.meta.main)
  process.exitCode = await runCompatibilityCli("gen_legacy_spec_id");
