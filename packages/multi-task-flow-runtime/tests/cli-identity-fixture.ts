import type { RunIdentity } from "../lib/orchestration-identity";

/** A disposable source-process identity; packaged CLI tests verify real artifact identity separately. */
export const fixtureIdentity: RunIdentity = {
  package_name: "@loomhelm/multi-task-flow",
  package_version: "0.2.56",
  build_id: "b".repeat(64),
  source_sha: "b".repeat(40),
  compatibility_line: "compat-v1",
  ledger_contract: 4,
  api_contract: 1,
  frontend_contract: 1,
  viewer_contract: 5,
};
process.env.LOOMHELM_CALLER_IDENTITY = JSON.stringify(fixtureIdentity);
