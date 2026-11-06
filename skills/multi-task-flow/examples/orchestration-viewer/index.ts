import { createDemoLedger } from "./ledger";
import { validateLedger } from "../../scripts/schema";

export const viewerValidationId = "orchestration-viewer";
export const viewerValidationName = "编排展示与交互验收";

/** Named synthetic orchestration for source-viewer development acceptance. */
export function createViewerValidationLedger(referenceTime = Date.now()) {
  const names: Record<string, string> = {
    "orchestration-sample": viewerValidationId,
    "plan-1": "viewer-validation-plan",
    sample: "orchestration-lab",
    "multi-task-flow": "orchestration-viewer",
    "sample/multi-task-flow": "orchestration-lab/orchestration-viewer",
  };
  const run = JSON.parse(
    JSON.stringify(createDemoLedger(referenceTime), (_key, value) =>
      typeof value === "string" ? (names[value] ?? value) : value,
    ),
  );
  run.schema_version = 2;
  run.contract_version = 2;
  run.source_schema_version = null;
  return validateLedger(run);
}
