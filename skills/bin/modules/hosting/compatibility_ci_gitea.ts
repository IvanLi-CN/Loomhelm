import { HostingError, type RepositoryBinding } from "./types";
import type { HostingBackend, ProviderResponse } from "./backend";
import { providerRecord } from "./compatibility_helpers";
import {
  policyFailure,
  policyObservation,
  responsePolicyError,
  policyStateForStatus,
  type PolicyObservation,
} from "./compatibility_ci_policy";

export async function readGiteaCiPolicy(
  binding: RepositoryBinding,
  backend: HostingBackend,
  branch: string,
): Promise<PolicyObservation> {
  const endpoint = `repos/${binding.fullName}/branches/${encodeURIComponent(branch)}`;
  let branchResponse: ProviderResponse;
  try {
    branchResponse = await backend.request(endpoint, {
      include: true,
      check: false,
      operation: "ci-protection",
    });
  } catch (error) {
    return policyFailure(
      "unavailable",
      null,
      "gitea_branch_metadata",
      error,
      "ci-protection",
    );
  }
  if (branchResponse.status !== 200) {
    const state = policyStateForStatus(branchResponse.status);
    return policyObservation(
      state,
      [],
      branchResponse.payload,
      "gitea_branch_metadata",
      branchResponse.observedAt,
      responsePolicyError(state, "ci-protection", branchResponse.status),
    );
  }
  try {
    const payload = providerRecord(branchResponse.payload, "ci-protection");
    const contexts = payload.status_check_contexts;
    if (
      !Array.isArray(contexts) ||
      !contexts.every((item) => typeof item === "string")
    )
      throw new HostingError(
        "invalid_provider_response",
        "Gitea branch policy has no readable status-check contexts",
        "ci-protection",
      );
    const requiredContexts = Array.from(
      new Set(contexts.map((item) => item.trim()).filter(Boolean)),
    );
    return policyObservation(
      requiredContexts.length ? "required" : "none",
      requiredContexts,
      branchResponse.payload,
      "gitea_branch_metadata",
      branchResponse.observedAt,
    );
  } catch (error) {
    return policyFailure(
      "unknown",
      branchResponse.payload,
      "gitea_branch_metadata",
      error,
      "ci-protection",
      branchResponse.observedAt,
    );
  }
}
