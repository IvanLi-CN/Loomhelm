import { runCompatibilityCli } from "./compatibility_cli";

if (import.meta.main)
  process.exitCode = await runCompatibilityCli("snapshot_local_image");
