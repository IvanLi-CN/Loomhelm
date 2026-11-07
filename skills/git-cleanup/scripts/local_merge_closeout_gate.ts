import { runCompatibilityCli } from "../../../bin/compatibility_cli";

if (import.meta.main)
  process.exitCode = await runCompatibilityCli("local_merge_closeout_gate");
