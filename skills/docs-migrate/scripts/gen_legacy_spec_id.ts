import { runCompatibilityCli } from "../../bin/compatibility_cli";

if (import.meta.main)
  process.exitCode = await runCompatibilityCli("gen_legacy_spec_id");
