import { runCompatibilityCli } from "./compatibility_cli";

if (import.meta.main)
  process.exitCode = await runCompatibilityCli(
    "instruction_architecture_check",
  );
