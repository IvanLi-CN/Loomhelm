import { analyzeActiveLongTask } from "./ownership";
import { analyzeBrowserReplay } from "./browser";
import { analyzeConflictReplay } from "./conflict";
import { analyzeFlowReplay } from "./flow";
import { analyzePrReplay } from "./pr";
import { analyzeReleaseTracking } from "./release";
import { analyzeReviewProof } from "./review";
import { analyzeVisualReplay } from "./visual";
import type { ReplayResult } from "./replay";

export type HistoricalDomain =
  | "active"
  | "browser"
  | "conflict"
  | "flow"
  | "pr"
  | "release"
  | "review"
  | "visual";

export function historicalDomain(path: string): HistoricalDomain {
  if (/active-long-task-ownership|zmp5f/i.test(path)) return "active";
  if (/gn7xq-gui-escalation|gui-escalation-gate/i.test(path)) return "browser";
  if (/pr-conflict-auto-heal|j4ha2/i.test(path)) return "conflict";
  if (/shared-ui-visual-evidence-gate|9878v/i.test(path)) return "visual";
  if (/flow-continue-lock-guard|yr954/i.test(path)) return "flow";
  if (/release-tracking/i.test(path)) return "release";
  if (/review-proof-dedupe-wait-guard|m3k8q/i.test(path)) return "review";
  return "pr";
}

export function analyzeHistoricalReplay(
  path: string,
  domain = historicalDomain(path),
): ReplayResult {
  if (domain === "active") return analyzeActiveLongTask(path);
  if (domain === "browser") return analyzeBrowserReplay(path);
  if (domain === "conflict") return analyzeConflictReplay(path);
  if (domain === "flow") return analyzeFlowReplay(path);
  if (domain === "release") return analyzeReleaseTracking(path);
  if (domain === "review") return analyzeReviewProof(path);
  if (domain === "visual") return analyzeVisualReplay(path);
  return analyzePrReplay(path);
}
