import { runCompatibilityCli } from "../../../bin/compatibility_cli";

if (import.meta.main)
  process.exitCode = await runCompatibilityCli("trim_whitespace");
