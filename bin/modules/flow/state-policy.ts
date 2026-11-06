import { FlowError, isRecord } from "./common";

export function repositoryBindingIdentity(
  value: unknown,
): [string, string, string] | undefined {
  if (!isRecord(value)) return undefined;
  const provider = value.provider;
  const host = value.host;
  const fullName = value.full_name ?? value.fullName;
  if (
    typeof provider !== "string" ||
    typeof host !== "string" ||
    typeof fullName !== "string" ||
    !provider.trim() ||
    !host.trim() ||
    !fullName.trim()
  )
    return undefined;
  return [
    provider.trim().toLowerCase(),
    host.trim().toLowerCase(),
    fullName.trim().toLowerCase(),
  ];
}

export function requireRepositoryBindingMatch(
  expected: unknown,
  actual: unknown,
): void {
  const expectedIdentity = repositoryBindingIdentity(expected);
  const actualIdentity = repositoryBindingIdentity(actual);
  if (
    !expectedIdentity ||
    !actualIdentity ||
    expectedIdentity.some((part, index) => part !== actualIdentity[index])
  )
    throw new FlowError("repository binding does not match the active ledger");
}

export function validatePostMergeReleasePolicy(
  evidence: Record<string, unknown>,
  binding: unknown,
  live: Record<string, unknown>,
): void {
  const finality = isRecord(evidence.finality) ? evidence.finality : undefined;
  const release =
    finality && isRecord(finality.release) ? finality.release : undefined;
  if (!release || release.status !== "not-applicable") return;
  const policy = release.policy_evidence;
  if (!isRecord(policy))
    throw new FlowError("post-merge release policy evidence is invalid");
  requireRepositoryBindingMatch(binding, policy.repository);
  if (
    typeof live.base_ref !== "string" ||
    !live.base_ref ||
    policy.target_branch !== live.base_ref
  )
    throw new FlowError(
      "post-merge release policy target branch does not match live PR",
    );
}
