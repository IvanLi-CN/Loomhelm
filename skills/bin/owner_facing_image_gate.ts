import { runCompatibilityCli } from "./compatibility_cli";

if (import.meta.main)
  process.exitCode = await runCompatibilityCli("owner_facing_image_gate");
