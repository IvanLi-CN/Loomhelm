import { statSync } from "node:fs";
import {
  checkAnchorsAndContext,
  checkEmpiricalAcceptance,
} from "./architecture_acceptance_contracts";
import { checkActiveSpecsAndImplementations } from "./architecture_active_review";
import {
  checkConvergenceBoundaries,
  checkReviewContracts,
} from "./architecture_review_contracts";
import { checkTrackerRoles } from "./architecture_tracker";
import { existsFile, pathFor } from "./architecture_contract_helpers";

export function checkArchitectureContracts(root: string): string[] {
  const findings: string[] = [];
  const agents = pathFor(root, "AGENTS.md");
  if (existsFile(agents) && statSync(agents).size > 10 * 1024)
    findings.push(`AGENTS_TOO_LARGE bytes=${statSync(agents).size}`);
  findings.push(
    ...checkConvergenceBoundaries(root),
    ...checkTrackerRoles(root),
    ...checkReviewContracts(root),
    ...checkEmpiricalAcceptance(root),
    ...checkAnchorsAndContext(root),
    ...checkActiveSpecsAndImplementations(root),
  );
  return findings;
}

export const check = checkArchitectureContracts;
export { checkConvergenceBoundaries } from "./architecture_review_contracts";
export { checkTrackerRoles } from "./architecture_tracker";
export {
  checkAnchorsAndContext,
  checkEmpiricalAcceptance,
} from "./architecture_acceptance_contracts";
export {
  currentOperationalContractText,
  currentSerialGateScanText,
} from "./architecture_markdown";
export {
  ACTIVE_REVIEW_SPEC_CONTRACTS,
  CANONICAL_REVIEW_REFERENCE,
  CURRENT_REVIEW_DISPOSITIONS,
  EMPIRICAL_ACCEPTANCE_REQUIRED_PHRASES,
  PR_STAGE_PARALLEL_CONTRACTS,
  PR_STAGE_SERIAL_GATE_FORBIDDEN,
  REVIEW_ANCHOR_CONTRACTS,
  REVIEW_CONSUMER_RELATIVE_PATHS,
  REVIEW_READINESS_CONTRACTS,
  REVIEW_READINESS_REQUIRED_PHRASES,
  REVIEW_SPEC_COMMON_REQUIREMENTS,
  REVIEW_SPEC_RETIRED_TERMS,
  RETIRED_REVIEW_DISPOSITIONS,
} from "./architecture_contract_data";
