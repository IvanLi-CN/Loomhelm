import { createReleaseState } from "./pr_release_state";
import { scanRelease } from "./pr_release_scan";
import { analyzePostMergeHandoff } from "./pr_handoff";
import type { Finding } from "./replay";

export function analyzePrRelease(path: string): Finding[] {
  const state = createReleaseState();
  scanRelease(state, path);
  for (const finding of analyzePostMergeHandoff(path).findings)
    if (!state.findings.some((item) => item.code === finding.code))
      state.findings.push(finding);
  return state.findings;
}
