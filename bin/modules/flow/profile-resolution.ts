import { FlowError, canonicalJson, isRecord, nonemptyString } from "./common";
import { logicalIdentity, profileOverrideUnavailable } from "./profile-hook";
import { supportedExplicitProfile } from "./profile-state";
import {
  FALLBACK_BLOCKERS_RE,
  collectStrings,
  responseStartedChild,
} from "./profile-attest-utils";

export function normaliseProfileResolution(
  value: unknown,
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    !isRecord(value.preferred) ||
    !Array.isArray(value.attempts) ||
    !isRecord(value.resolved) ||
    ![null, "profile_override_unavailable"].includes(
      value.fallback_reason as never,
    )
  )
    throw new FlowError(
      "profile_resolution does not match the required schema",
    );
  const preferred = value.preferred;
  const resolved = value.resolved as Record<string, unknown>;
  const childThreadId = nonemptyString(resolved.child_thread_id);
  const turnId = nonemptyString(resolved.turn_id);
  if (
    !supportedProfileRecord(preferred) ||
    !supportedProfilePair(resolved) ||
    Object.keys(resolved).length !== 4 ||
    !childThreadId ||
    !turnId
  )
    throw new FlowError(
      "profile_resolution contains an unsupported model or reasoning_effort",
    );
  const attempts = value.attempts.map((attempt) => {
    if (
      !isRecord(attempt) ||
      Object.keys(attempt).length !== 5 ||
      attempt.request_mode !== "explicit" ||
      !["unsupported", "started"].includes(String(attempt.outcome)) ||
      !nonemptyString(attempt.tool_use_id) ||
      !/^[0-9a-f]{64}$/.test(String(attempt.evidence_sha256)) ||
      !supportedProfileRecord(attempt.requested)
    )
      throw new FlowError("profile_resolution attempt is invalid");
    return {
      tool_use_id: attempt.tool_use_id,
      request_mode: "explicit",
      requested: attempt.requested,
      outcome: attempt.outcome,
      evidence_sha256: attempt.evidence_sha256,
    };
  });
  if (
    value.fallback_reason === null &&
    (attempts.length !== 1 ||
      attempts[0]?.outcome !== "started" ||
      canonicalJson(attempts[0]?.requested) !==
        canonicalJson({ model: resolved.model, effort: resolved.effort }))
  )
    throw new FlowError(
      "direct profile_resolution must contain one explicit started attempt",
    );
  if (
    value.fallback_reason !== null &&
    (attempts.length !== 2 ||
      attempts[0]?.outcome !== "unsupported" ||
      attempts[1]?.outcome !== "started" ||
      canonicalJson(attempts[0]?.requested) ===
        canonicalJson(attempts[1]?.requested) ||
      canonicalJson(attempts[1]?.requested) !==
        canonicalJson({ model: resolved.model, effort: resolved.effort }))
  )
    throw new FlowError(
      "fallback profile_resolution must contain unsupported then started explicit attempts with different profiles",
    );
  return {
    preferred,
    attempts,
    resolved,
    fallback_reason: value.fallback_reason,
  };
}

function supportedProfileRecord(
  value: unknown,
): value is { model: string; effort: string } {
  return supportedExplicitProfile(value);
}

function supportedProfilePair(value: Record<string, unknown>): boolean {
  return supportedExplicitProfile({ model: value.model, effort: value.effort });
}

export function eligibleFailure(
  output: unknown,
  model: string,
  effort: string,
): boolean {
  const text = collectStrings(output).join("\n");
  return (
    !responseStartedChild(output) &&
    !FALLBACK_BLOCKERS_RE.test(text) &&
    profileOverrideUnavailable(output, model, effort)
  );
}

export function fallbackIdentity(
  sessionId: string,
  args: Record<string, unknown>,
): ReturnType<typeof logicalIdentity> {
  return logicalIdentity(sessionId, args);
}
