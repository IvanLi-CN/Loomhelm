import { FlowError, isRecord, normalizeSha } from "./common";

const DEPLOYMENT_FIELDS = [
  "deployment_id",
  "source_sha",
  "bound_sha",
  "relationship",
  "provenance_boundary",
  "evidence_source",
  "operation_id",
  "observed_state",
  "external_locator",
];

export interface DeploymentIdentity {
  deployment_id: string;
  source_sha: string;
  bound_sha: string;
  relationship: string;
  provenance_boundary: string;
  evidence_source: string;
  operation_id: string;
  observed_state: string;
  external_locator: string;
  [key: string]: unknown;
}

export function normalizeDeploymentIdentity(
  value: unknown,
  mergeSha?: string,
): DeploymentIdentity {
  if (
    !isRecord(value) ||
    !DEPLOYMENT_FIELDS.every((field) => Object.hasOwn(value, field))
  )
    throw new FlowError(
      "acceptance evidence deployment_identity is not a verified provider receipt",
    );
  const result = { ...value } as Record<string, unknown>;
  for (const field of DEPLOYMENT_FIELDS.filter(
    (field) => !["source_sha", "bound_sha"].includes(field),
  )) {
    if (typeof result[field] !== "string" || !result[field].trim())
      throw new FlowError(
        "acceptance evidence deployment_identity is not a verified provider receipt",
      );
    result[field] = result[field].trim();
  }
  result.source_sha = normalizeSha(
    result.source_sha,
    "deployment_identity.source_sha",
  );
  result.bound_sha = normalizeSha(
    result.bound_sha,
    "deployment_identity.bound_sha",
  );
  if (
    result.relationship !== "deployed-from" ||
    result.provenance_boundary !== "deployment-provider" ||
    result.evidence_source !== "deployment-receipt" ||
    result.observed_state !== "verified"
  )
    throw new FlowError(
      "acceptance evidence deployment_identity is not a verified provider receipt",
    );
  if (
    mergeSha &&
    (result.source_sha !== mergeSha || result.bound_sha !== mergeSha)
  )
    throw new FlowError(
      "post_deploy acceptance deployment identity must bind the merge SHA",
    );
  return result as DeploymentIdentity;
}
