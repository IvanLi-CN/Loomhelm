import { HostingError, type RepositoryBinding } from "./types";
import type { HostingBackend, ProviderResponse } from "./backend";
import { providerRecord } from "./compatibility_helpers";
import {
  contextsFromPolicy,
  policyFailure,
  policyObservation,
  responsePolicyError,
  policyStateForStatus,
  type PolicyObservation,
} from "./compatibility_ci_policy";

const PLAN_LIMITED_PROTECTION_MESSAGE =
  "Upgrade to GitHub Pro or make this repository public to enable this feature.";

export async function readGithubCiPolicy(
  binding: RepositoryBinding,
  backend: HostingBackend,
  branch: string,
): Promise<PolicyObservation> {
  const endpoint =
    `repos/${binding.fullName}/branches/${encodeURIComponent(branch)}` +
    "/protection/required_status_checks";
  let protectionResponse: ProviderResponse;
  try {
    protectionResponse = await backend.request(endpoint, {
      include: true,
      check: false,
      operation: "ci-protection",
    });
  } catch (error) {
    return policyFailure(
      "unavailable",
      null,
      "github_protection",
      error,
      "ci-protection",
    );
  }
  if (protectionResponse.status === 404)
    return policyObservation(
      "none",
      [],
      null,
      "github_protection",
      protectionResponse.observedAt,
    );
  if (protectionResponse.status === 200) {
    try {
      const requiredContexts = contextsFromPolicy(
        protectionResponse.payload,
        "ci-protection",
      );
      return policyObservation(
        requiredContexts.length ? "required" : "none",
        requiredContexts,
        protectionResponse.payload,
        "github_protection",
        protectionResponse.observedAt,
      );
    } catch (error) {
      return policyFailure(
        "unknown",
        protectionResponse.payload,
        "github_protection",
        error,
        "ci-protection",
        protectionResponse.observedAt,
      );
    }
  }
  return readGithubProtectionFallback(
    binding,
    backend,
    branch,
    protectionResponse,
  );
}

async function readGithubProtectionFallback(
  binding: RepositoryBinding,
  backend: HostingBackend,
  branch: string,
  protectionResponse: ProviderResponse,
): Promise<PolicyObservation> {
  const payload =
    protectionResponse.payload !== null &&
    typeof protectionResponse.payload === "object"
      ? (protectionResponse.payload as Record<string, unknown>)
      : {};
  const planLimited =
    protectionResponse.status === 403 &&
    payload.message === PLAN_LIMITED_PROTECTION_MESSAGE;
  if (planLimited) {
    const endpoint = `repos/${binding.fullName}/branches/${encodeURIComponent(branch)}`;
    let branchResponse: ProviderResponse;
    try {
      branchResponse = await backend.request(endpoint, {
        include: true,
        check: false,
        operation: "ci-branch-policy",
      });
    } catch (error) {
      return policyFailure(
        "unavailable",
        protectionResponse.payload,
        "github_branch_metadata",
        error,
        "ci-branch-policy",
        protectionResponse.observedAt,
      );
    }
    try {
      if (branchResponse.status !== 200) {
        const state = policyStateForStatus(branchResponse.status);
        return policyObservation(
          state,
          [],
          protectionResponse.payload,
          "github_branch_metadata",
          branchResponse.observedAt,
          responsePolicyError(state, "ci-branch-policy", branchResponse.status),
        );
      }
      const branchPayload = providerRecord(
        branchResponse.payload,
        "ci-branch-policy",
      );
      if (branchPayload.name === branch && branchPayload.protected === false)
        return policyObservation(
          "none",
          [],
          {
            policy_source: "branch_metadata",
            protected: false,
            required_status_checks: null,
            branch: branchPayload,
          },
          "github_branch_metadata",
          branchResponse.observedAt,
        );
      return policyObservation(
        "unknown",
        [],
        protectionResponse.payload,
        "github_branch_metadata",
        branchResponse.observedAt,
        responsePolicyError(
          "unknown",
          "ci-branch-policy",
          branchResponse.status,
          "branch_policy_mismatch",
        ),
      );
    } catch (error) {
      return policyFailure(
        "unknown",
        protectionResponse.payload,
        "github_branch_metadata",
        error,
        "ci-branch-policy",
        branchResponse.observedAt,
      );
    }
  }
  const state = policyStateForStatus(protectionResponse.status);
  return policyObservation(
    state,
    [],
    protectionResponse.payload,
    "github_protection",
    protectionResponse.observedAt,
    responsePolicyError(state, "ci-protection", protectionResponse.status),
  );
}
