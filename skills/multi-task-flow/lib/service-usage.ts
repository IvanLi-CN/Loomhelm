import { existsSync } from "node:fs";
import { join } from "node:path";
import { servicePaths } from "../lib/service-paths";
import { ServiceState } from "../lib/service-state";
import { API_VERSION, releaseManifestSchema } from "../lib/service-contract";
import { readRegular, LedgerStore, safeId } from "../lib/store";
import { requireCondition } from "../lib/errors";

function installedState(root: string): ServiceState | null {
  const paths = servicePaths();
  if (root !== paths.data || !existsSync(join(paths.config, "service.json")))
    return null;
  return new ServiceState(paths);
}
export function checkViewerCompatibility(root: string): void {
  const state = installedState(root);
  if (!state) return;
  const config = state.config();
  const manifest = releaseManifestSchema.parse(
    JSON.parse(
      readRegular(
        join(state.paths.releases, config.current_build, "manifest.json"),
      ),
    ),
  );
  requireCondition(
    manifest.build_id === config.current_build &&
      manifest.api_versions.includes(API_VERSION),
    "INCOMPATIBLE_API",
    "Installed viewer requires explicit maintenance before this CLI can continue",
  );
}
export function renewViewerUsage(root: string, runId: string): void {
  const state = installedState(root);
  if (!state || state.runtime().phase !== "running") return;
  const ledger = new LedgerStore(root, safeId(runId)).read();
  const thread = safeId(ledger.control.owner_thread_id);
  state.renew(
    {
      id: `agent:${thread}:${runId}`,
      kind: "agent",
      thread_id: thread,
      run_id: runId,
    },
    state.config().agent_ttl_ms,
  );
}
