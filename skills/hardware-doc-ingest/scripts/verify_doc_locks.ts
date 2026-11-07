import { runCompatibilityCli } from "../../bin/compatibility_cli";

if (import.meta.main)
  process.exitCode = await runCompatibilityCli("verify_doc_locks");
