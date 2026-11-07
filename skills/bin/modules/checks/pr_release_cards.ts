import { isRecord } from "./replay";
import {
  asSha,
  expectedSurfaces,
  identifiersMatch,
  shaMatches,
  stringValue,
  type ReleaseExpected,
} from "./pr_release_support";
import {
  cardIdentity,
  structuredExpectation,
  type ReleaseState,
} from "./pr_release_state";

function validRunId(value: unknown): string | undefined {
  return ![true, false].includes(value as boolean) &&
    (typeof value === "string" || typeof value === "number") &&
    /^[1-9]\d*$/.test(String(value))
    ? String(value)
    : undefined;
}

function releaseRunId(card: Record<string, unknown>): string | undefined {
  return validRunId(
    card.release_run_id ?? card.release_run ?? card.id ?? card.databaseId,
  );
}

function trustedCiRun(
  card: Record<string, unknown>,
  phase: string | undefined,
): [string, string] | undefined {
  const run = validRunId(
    phase === "post_merge_target_ci"
      ? card.target_ci_run_id
      : phase === "pr_head_ci"
        ? card.pr_ci_run_id
        : undefined,
  );
  const repo = stringValue(card.target_repo)?.toLowerCase();
  if (!run || !repo || card.transient !== true || card.retry_safe !== true)
    return undefined;
  return [run, repo];
}

function resetReleaseRunState(
  state: ReleaseState,
  preservePreIdentityRerun: boolean,
): void {
  const priorRerunCount = state.rerunCount;
  const priorRerunViolation = state.rerunViolation;
  const priorLastRerunLine = state.lastRerunLine;
  const priorReleaseRerunAttempted = state.releaseRerunAttempted;
  const priorAuthorization = state.userRetryAuthorization;
  state.actualRunId = undefined;
  state.failureEvidence = false;
  state.failureEvidenceLine = 0;
  state.idempotentRun = false;
  state.userAuthorizedRerun = false;
  state.userRetryAuthorization = undefined;
  state.rerunCount = preservePreIdentityRerun ? priorRerunCount : 0;
  state.rerunViolation = preservePreIdentityRerun ? priorRerunViolation : 0;
  state.lastRerunLine = preservePreIdentityRerun ? priorLastRerunLine : 0;
  state.releaseRerunAttempted = preservePreIdentityRerun
    ? priorReleaseRerunAttempted
    : false;
  if (preservePreIdentityRerun)
    state.userRetryAuthorization = priorAuthorization;
}

function fallbackFailureEvidence(
  state: ReleaseState,
  card: Record<string, unknown>,
  cardRun: string | undefined,
): boolean {
  if (
    cardRun ||
    state.actualRunId ||
    stringValue(card.tracking_phase) ||
    !state.target.repo ||
    !state.target.sha
  )
    return false;
  const sha = asSha(
    card.headSha ?? card.head_sha ?? card.target_sha ?? card.source_sha,
  );
  const repoPath = `/${state.target.repo.toLowerCase()}/actions/runs/`;
  const hasBoundRunUrl = Object.values(card).some(
    (value) =>
      typeof value === "string" &&
      value.toLowerCase().includes(repoPath) &&
      /\/actions\/runs\/[1-9]\d*/i.test(value),
  );
  return Boolean(sha && shaMatches(sha, state.target.sha) && hasBoundRunUrl);
}

export function processReleaseCards(
  state: ReleaseState,
  line: number,
  cards: Record<string, unknown>[],
  currentEpoch: string | undefined,
): void {
  for (const card of cards) {
    const identity = cardIdentity(card);
    const cardEpoch = identity.epoch ?? currentEpoch;
    const cardExpected = structuredExpectation(card);
    if (
      typeof card.release_expected === "boolean" &&
      typeof card.release_enabled === "boolean" &&
      card.release_expected !== card.release_enabled
    )
      state.identityConflictLine ||= line;
    if (cardExpected !== undefined && cardEpoch) {
      if (state.epoch && state.epoch === cardEpoch) {
        for (const [key, value] of Object.entries(identity))
          if (
            key !== "epoch" &&
            value &&
            state.target[key as keyof typeof state.target] &&
            key !== "sha"
              ? key === "tag"
                ? !identifiersMatch(
                    value,
                    state.target[key as keyof typeof state.target]!,
                  )
                : value.toLowerCase() !==
                  state.target[key as keyof typeof state.target]!.toLowerCase()
              : key === "sha" &&
                value &&
                state.target.sha &&
                !shaMatches(value, state.target.sha)
          )
            state.identityConflictLine ||= line;
        if (state.expected !== undefined && state.expected !== cardExpected)
          state.identityConflictLine ||= line;
      } else {
        const preservePreIdentityRerun = !state.epoch;
        if (state.epoch && state.target.repo && !identity.repo)
          state.epochResetMissingIdentity = true;
        state.epoch = cardEpoch;
        state.expected = cardExpected as ReleaseExpected;
        state.releaseExpectationLine = line;
        state.target = identity;
        state.candidate = identity.tag;
        state.bound = undefined;
        state.mergeShaValue = undefined;
        state.publicationFacts = [];
        state.expectedSurfaceSet = new Set();
        state.surfaceIdentities = new Map();
        resetReleaseRunState(state, preservePreIdentityRerun);
      }
    } else if (state.epoch && cardEpoch === state.epoch) {
      if (
        identity.repo &&
        state.target.repo &&
        identity.repo !== state.target.repo
      )
        state.identityConflictLine ||= line;
      if (
        identity.branch &&
        state.target.branch &&
        identity.branch !== state.target.branch
      )
        state.identityConflictLine ||= line;
      if (
        identity.sha &&
        state.target.sha &&
        !shaMatches(identity.sha, state.target.sha)
      )
        state.identityConflictLine ||= line;
      if (
        identity.tag &&
        state.candidate &&
        !identifiersMatch(identity.tag, state.candidate)
      )
        state.identityConflictLine ||= line;
    }
    if (state.epoch && cardEpoch === state.epoch) {
      const sha = asSha(card.publication_sha);
      if (sha) state.mergeShaValue = sha;
      if (
        Array.isArray(card.release_surfaces) ||
        Array.isArray(card.expected_surfaces)
      )
        for (const surface of (card.release_surfaces ??
          card.expected_surfaces) as unknown[])
          if (typeof surface === "string" && expectedSurfaces.has(surface))
            state.expectedSurfaceSet.add(surface);
      if (isRecord(card.release_surface_identities))
        for (const [surface, values] of Object.entries(
          card.release_surface_identities,
        ))
          state.surfaceIdentities.set(
            surface,
            new Set(
              (Array.isArray(values) ? values : [values]).filter(
                (item): item is string => typeof item === "string",
              ),
            ),
          );
      const run = releaseRunId(card);
      const trustedIdentity = Boolean(
        cardExpected !== undefined &&
        identity.repo &&
        identity.branch &&
        identity.sha &&
        (identity.epoch ?? currentEpoch) === state.epoch,
      );
      if (
        trustedIdentity &&
        state.actualRunId &&
        run &&
        run !== state.actualRunId
      ) {
        state.identityConflictLine ||= line;
        state.failureEvidence = false;
        state.failureEvidenceLine = 0;
        state.idempotentRun = false;
      }
      if (state.actualRunId === undefined && trustedIdentity && run)
        state.actualRunId = run;
      if (
        card.idempotent === true &&
        card.retry_safe === true &&
        state.actualRunId &&
        run === state.actualRunId
      )
        state.idempotentRun = true;
      const runState = String(
        card.status ?? card.state ?? card.conclusion ?? "",
      ).toLowerCase();
      const cardRun = validRunId(
        card.release_run_id ?? card.release_run ?? card.run_id ?? card.id,
      );
      const runMatches =
        state.actualRunId !== undefined && cardRun === state.actualRunId;
      const fallbackFailure = fallbackFailureEvidence(state, card, cardRun);
      if (
        (runMatches || fallbackFailure) &&
        (runState === "failure" ||
          runState === "failed" ||
          runState === "error" ||
          card.success === false ||
          (asSha(card.headSha) && runState === "failure"))
      ) {
        state.failureEvidence = true;
        state.failureEvidenceLine = line;
      }
      const phase = stringValue(card.tracking_phase);
      const ciRun = trustedCiRun(card, phase);
      if (ciRun)
        (phase === "post_merge_target_ci"
          ? state.targetCiRuns
          : state.prCiRuns
        ).set(ciRun[0], ciRun[1]);
    }
  }
  for (const card of cards) {
    const phase = stringValue(card.tracking_phase);
    const ciRun = trustedCiRun(card, phase);
    if (ciRun)
      (phase === "post_merge_target_ci"
        ? state.targetCiRuns
        : state.prCiRuns
      ).set(ciRun[0], ciRun[1]);
  }
}
