import { runCompatibilityCli } from "./_runtime/compatibility_cli";

if (import.meta.main)
  process.exitCode = await runCompatibilityCli("ingest_mineru_extract");
