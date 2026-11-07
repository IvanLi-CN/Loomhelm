import { redactProviderValue } from "./redact";
import { HostingError, type RepositoryBinding } from "./types";
import type { HostingBackend, ProviderResponse } from "./backend";
import {
  providerRecord,
  providerSha,
  requiredShaValue,
  unsupportedResponse,
} from "./compatibility_helpers";
import { readGiteaCiPolicy } from "./compatibility_ci_gitea";
import { readGithubCiPolicy } from "./compatibility_ci_github";
import {
  readCiSurface,
  type SurfaceObservation,
} from "./compatibility_ci_policy";
import { normalizeCiResult } from "./compatibility_ci_normalize";

const activeReruns = new Map<string, Promise<Record<string, unknown>>>();
const attemptedReruns = new Set<string>();

function rerunKey(
  binding: RepositoryBinding,
  runId: number,
  sha: string,
): string {
  return `${binding.provider}:${binding.host}:${binding.fullName}:${runId}:${sha}`;
}

export async function ciFacts(
  binding: RepositoryBinding,
  backend: HostingBackend,
  branch: string,
  rawSha: string,
): Promise<Record<string, unknown>> {
  const sha = requiredShaValue(rawSha, "sha", "ci-facts");
  const policy =
    binding.provider === "github"
      ? await readGithubCiPolicy(binding, backend, branch)
      : await readGiteaCiPolicy(binding, backend, branch);
  const status = await readCiSurface(
    backend,
    `repos/${binding.fullName}/commits/${sha}/status`,
    "ci-status",
  );
  const checks: SurfaceObservation =
    binding.provider === "github"
      ? await readCiSurface(
          backend,
          `repos/${binding.fullName}/commits/${sha}/check-runs`,
          "ci-checks",
        )
      : {};
  let runs = await readCiSurface(
    backend,
    binding.provider === "github"
      ? `repos/${binding.fullName}/actions/runs?head_sha=${sha}&per_page=100`
      : `repos/${binding.fullName}/actions/tasks?head_sha=${sha}&limit=100`,
    "ci-runs",
  );
  if (
    binding.provider === "gitea" &&
    runs.response &&
    unsupportedResponse(runs.response)
  )
    runs = await readCiSurface(
      backend,
      `repos/${binding.fullName}/actions/runs?head_sha=${sha}&limit=100`,
      "ci-runs",
    );
  return normalizeCiResult(branch, sha, policy, status, checks, runs);
}

async function performRerun(
  binding: RepositoryBinding,
  backend: HostingBackend,
  runId: number,
  sha: string,
  claimKey: string,
): Promise<Record<string, unknown>> {
  const verification = await backend.request(
    `repos/${binding.fullName}/actions/runs/${runId}`,
    {
      include: true,
      requireStatus: true,
      check: false,
      operation: "ci-rerun-verify",
    },
  );
  if (unsupportedResponse(verification))
    throw new HostingError(
      "unsupported_capability",
      "provider cannot verify CI rerun identity",
      "ci-rerun",
    );
  if (
    verification.status === null ||
    verification.status < 200 ||
    verification.status >= 300
  )
    throw new HostingError(
      "provider_request_failed",
      "CI rerun verification failed",
      "ci-rerun",
      { status: verification.status },
    );
  const record = providerRecord(verification.payload, "ci-rerun");
  const verifiedRunId = providerRunId(record.id);
  if (verifiedRunId === null || verifiedRunId !== runId)
    throw new HostingError(
      "rerun_id_mismatch",
      "rerun response is not bound to the requested run ID",
      "ci-rerun",
    );
  if (providerSha(record.head_sha ?? record.sha) !== sha)
    throw new HostingError(
      "rerun_sha_mismatch",
      "rerun response is not bound to the expected SHA",
      "ci-rerun",
    );
  attemptedReruns.add(claimKey);
  let request: ProviderResponse;
  try {
    request = await backend.request(
      `repos/${binding.fullName}/actions/runs/${runId}/rerun`,
      {
        method: "POST",
        include: true,
        requireStatus: true,
        check: false,
        operation: "ci-rerun",
      },
    );
  } catch (error) {
    if (
      error instanceof HostingError &&
      ["command_unavailable", "invalid_endpoint", "invalid_arguments"].includes(
        error.code,
      )
    )
      attemptedReruns.delete(claimKey);
    throw error;
  }
  if (unsupportedResponse(request))
    throw new HostingError(
      "unsupported_capability",
      "provider does not support CI reruns",
      "ci-rerun",
    );
  if (request.status === null || request.status < 200 || request.status >= 300)
    throw new HostingError(
      "provider_request_failed",
      "CI rerun request failed",
      "ci-rerun",
      { status: request.status },
    );
  return {
    run_id: verifiedRunId,
    head_sha: sha,
    state: "rerun_requested",
    observed_at: verification.observedAt,
    raw: {
      request: redactProviderValue(request.payload),
      verification: redactProviderValue(record),
    },
  };
}

function providerRunId(value: unknown): number | null {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function rerunCi(
  binding: RepositoryBinding,
  backend: HostingBackend,
  rawRunId: string,
  rawSha: string,
): Promise<Record<string, unknown>> {
  const runId = Number(rawRunId);
  const sha = requiredShaValue(rawSha, "expected-sha", "ci-rerun");
  if (!Number.isSafeInteger(runId) || runId < 1)
    throw new HostingError(
      "invalid_arguments",
      "--run-id must be a positive integer",
      "ci-rerun",
    );
  const claimKey = rerunKey(binding, runId, sha);
  const active = activeReruns.get(claimKey);
  if (active) return active;
  if (attemptedReruns.has(claimKey))
    throw new HostingError(
      "rerun_already_requested",
      "CI rerun has already been attempted for this run and SHA",
      "ci-rerun",
    );
  const operation = performRerun(binding, backend, runId, sha, claimKey);
  activeReruns.set(claimKey, operation);
  try {
    return await operation;
  } finally {
    activeReruns.delete(claimKey);
  }
}
