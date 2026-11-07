import { runCompatibilityCli } from "../../../bin/compatibility_cli";

if (import.meta.main)
  process.exitCode = await runCompatibilityCli("pr_body_image_gate");
