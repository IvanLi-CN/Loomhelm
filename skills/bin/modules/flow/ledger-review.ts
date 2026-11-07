import {
  FlowError,
  PR_BOUND_FLOW_TYPES,
  deepClone,
  isoNow,
  isRecord,
} from "./common";
import {
  gitChangedPaths,
  gitCommit,
  gitIsAncestor,
  gitIsMovingRef,
  requireCleanCurrentHead,
} from "./git";
import { finalizeReviewWaveState, openReviewWaveState } from "./review-ledger";
import { authorizeRepairState } from "./review-repair";
import { recordSubagentReviewState } from "./review-record";
import { bindingForLedger, readLivePullRequest } from "../hosting/pull-request";
import type { FlowLedger } from "./ledger";

export function assessReviewNecessity(
  ledger: FlowLedger,
  tier: number,
  reason: string,
): Record<string, unknown> {
  if (![1, 2, 3, 4].includes(tier) || !reason.trim())
    throw new FlowError(
      "review assessment requires a valid tier and non-empty Agent rationale",
    );
  if (!ledger.repo)
    throw new FlowError("review assessment requires a repository-bound ledger");
  const [head] = requireCleanCurrentHead(ledger.repo);
  return ledger.activeUpdate((current) => {
    const [lockedHead] = requireCleanCurrentHead(ledger.repo!);
    if (lockedHead !== head)
      throw new FlowError(
        "review assessment inputs changed; refresh and retry",
      );
    if (
      !PR_BOUND_FLOW_TYPES.has(String(current.flow_type)) &&
      current.flow_type !== "local-merge"
    )
      throw new FlowError(
        "review assessment is only used by direct delivery flows",
      );
    const review = current.review as Record<string, unknown>;
    if (
      review.pr_ref ||
      review.active_wave_id ||
      review.active_epoch_id ||
      (Array.isArray(review.epochs) && review.epochs.length)
    )
      throw new FlowError(
        "review assessment is locked once review convergence starts",
      );
    const previous =
      isRecord(current.review_assessment) &&
      current.review_assessment.tier !== null
        ? deepClone(current.review_assessment)
        : undefined;
    if (
      isRecord(current.review_assessment) &&
      current.review_assessment.source === "pre-tier-migration"
    )
      throw new FlowError(
        "pre-tier direct review assessment is immutable for the active flow",
      );
    if (previous) {
      const history = Array.isArray(current.review_assessment_history)
        ? current.review_assessment_history
        : [];
      current.review_assessment_history = [...history, previous];
    }
    const assessment = {
      tier,
      reason: reason.trim(),
      assessed_at: isoNow(),
      assessed_head_sha: head,
      source: "agent-assessment",
    };
    current.review_assessment = assessment;
    current.review_mode =
      tier === 1
        ? "not-required"
        : tier === 2
          ? "advisory"
          : `mandatory-tier-${tier}`;
    current.events = [
      ...(Array.isArray(current.events) ? current.events : []),
      {
        type: previous
          ? "review_necessity_reassessed"
          : "review_necessity_assessed",
        tier,
        reason: reason.trim(),
        head_sha: head,
        at: isoNow(),
      },
    ];
    return {
      review_assessment: assessment,
      review_mode: current.review_mode,
    };
  });
}

export function openReviewWave(
  ledger: FlowLedger,
  options: {
    stage: string;
    baseRef: string;
    headSha?: string | undefined;
    laneSpecs: { lane: string; model: string; effort: string }[];
    scopeClass?: string | undefined;
    previousHeadSha?: string | undefined;
    repairPermitId?: string | undefined;
    highRequirement?: boolean | undefined;
    arbitrationConflicts?: string[] | undefined;
    arbitrationBlockerFingerprints?: string[] | undefined;
  },
): Record<string, unknown> {
  if (!ledger.repo)
    throw new FlowError("review waves require a repository-bound ledger");
  const baseRef = options.baseRef.trim();
  if (!gitIsMovingRef(ledger.repo, baseRef))
    throw new FlowError(
      "review wave base ref must be a moving local or remote branch ref",
    );
  const head = requireCleanCurrentHead(ledger.repo, options.headSha)[0];
  const base = gitCommit(ledger.repo, baseRef);
  if (base === head)
    throw new FlowError("review wave base ref cannot be the candidate HEAD");
  if (options.stage === "repair") {
    if (!options.previousHeadSha)
      throw new FlowError("repair review wave requires previous_head_sha");
    const previous = gitCommit(ledger.repo, options.previousHeadSha);
    if (
      previous === head ||
      !gitIsAncestor(ledger.repo, previous, head) ||
      !gitChangedPaths(ledger.repo, previous, head).length
    )
      throw new FlowError(
        "repair head must be a new descendant with a non-empty repair delta",
      );
  }
  const snapshot = ledger.read();
  const snapshotReview = isRecord(snapshot.review) ? snapshot.review : {};
  const needsLivePr =
    ["initial", "repair"].includes(options.stage) &&
    (PR_BOUND_FLOW_TYPES.has(String(snapshot.flow_type)) ||
      typeof snapshotReview.pr_ref === "string");
  const prRef =
    typeof snapshotReview.pr_ref === "string"
      ? snapshotReview.pr_ref
      : undefined;
  const live =
    needsLivePr && prRef ? readLivePullRequest(ledger.repo, prRef) : undefined;
  if (
    live &&
    (live.facts.state !== "OPEN" ||
      live.facts.head_sha !== head ||
      live.facts.base_sha !== base)
  )
    throw new FlowError(
      "PR-bound review waves require live PR base and head facts",
    );
  return ledger.activeUpdate((current) => {
    const [lockedHead] = requireCleanCurrentHead(ledger.repo!, options.headSha);
    const lockedBase = gitCommit(ledger.repo!, baseRef);
    if (lockedHead !== head || lockedBase !== base)
      throw new FlowError("review wave inputs changed; refresh and retry");
    const lockedReview = isRecord(current.review) ? current.review : {};
    const lockedPrRef =
      typeof lockedReview.pr_ref === "string" ? lockedReview.pr_ref : undefined;
    if (lockedPrRef !== prRef)
      throw new FlowError("review wave PR binding changed; refresh and retry");
    const lockedLive =
      needsLivePr && lockedPrRef
        ? readLivePullRequest(ledger.repo!, lockedPrRef)
        : undefined;
    if (
      Boolean(lockedLive) !== Boolean(live) ||
      (lockedLive &&
        live &&
        (lockedLive.facts.state !== live.facts.state ||
          lockedLive.facts.base_sha !== live.facts.base_sha ||
          lockedLive.facts.head_sha !== live.facts.head_sha ||
          lockedLive.facts.base_ref !== live.facts.base_ref))
    )
      throw new FlowError(
        "review wave live PR facts changed; refresh and retry",
      );
    if (
      lockedLive &&
      (lockedLive.facts.state !== "OPEN" ||
        lockedLive.facts.head_sha !== lockedHead ||
        lockedLive.facts.base_sha !== lockedBase)
    )
      throw new FlowError(
        "PR-bound review waves require live PR base and head facts",
      );
    const assessment = isRecord(current.review_assessment)
      ? current.review_assessment
      : undefined;
    if (assessment?.tier !== 3 && assessment?.tier !== 4)
      throw new FlowError(
        "the recorded review necessity tier does not require a review wave",
      );
    const review = current.review as Record<string, unknown>;
    if (
      current.flow_type !== "local-merge" &&
      PR_BOUND_FLOW_TYPES.has(String(current.flow_type)) &&
      !review.pr_ref
    )
      throw new FlowError(
        "direct PR review requires a bound live PR before the review wave opens",
      );
    if (needsLivePr && !live)
      throw new FlowError(
        "direct PR review requires a bound live PR before the review wave opens",
      );
    if (lockedLive) {
      const binding = bindingForLedger(lockedLive.binding);
      const storedBinding = current.repository_binding;
      if (
        isRecord(storedBinding) &&
        (storedBinding.provider !== binding.provider ||
          storedBinding.host !== binding.host ||
          storedBinding.full_name !== binding.full_name)
      )
        throw new FlowError(
          "review wave repository binding does not match the live PR",
        );
      current.repository_binding = binding;
      current.provider_facts = { pr: lockedLive.facts };
      review.pr_base_sha = lockedLive.facts.base_sha;
      review.pr_head_sha = lockedLive.facts.head_sha;
    }
    return openReviewWaveState(current, {
      stage: options.stage,
      laneSpecs: options.laneSpecs,
      scopeClass: options.scopeClass,
      previousHeadSha: options.previousHeadSha,
      repairPermitId: options.repairPermitId,
      highRequirement: options.highRequirement,
      arbitrationConflicts: options.arbitrationConflicts,
      arbitrationBlockerFingerprints: options.arbitrationBlockerFingerprints,
      baseRef,
      baseSha: base,
      headSha: head,
    });
  });
}

export function recordSubagentReview(
  ledger: FlowLedger,
  options: Parameters<typeof recordSubagentReviewState>[1],
): Record<string, unknown> {
  if (!ledger.repo)
    throw new FlowError(
      "sub-agent review evidence requires a repository-bound ledger",
    );
  const [head] = requireCleanCurrentHead(ledger.repo, options.headSha);
  const base = gitCommit(ledger.repo, options.baseRef);
  return ledger.activeUpdate((current) =>
    (() => {
      const [lockedHead] = requireCleanCurrentHead(
        ledger.repo!,
        options.headSha,
      );
      const lockedBase = gitCommit(ledger.repo!, options.baseRef);
      if (lockedHead !== head || lockedBase !== base)
        throw new FlowError("review receipt inputs changed; refresh and retry");
      const review = isRecord(current.review) ? current.review : {};
      const prRef =
        typeof review.pr_ref === "string" ? review.pr_ref : undefined;
      if (prRef) {
        const live = readLivePullRequest(ledger.repo!, prRef);
        if (
          live.facts.state !== "OPEN" ||
          live.facts.head_sha !== lockedHead ||
          live.facts.base_sha !== lockedBase
        )
          throw new FlowError(
            "review receipt live PR facts changed; refresh and retry",
          );
      }
      return recordSubagentReviewState(current, {
        ...options,
        repoPath: ledger.repo,
        baseSha: lockedBase,
        headSha: lockedHead,
      });
    })(),
  );
}

export function finalizeReviewWave(
  ledger: FlowLedger,
  waveId: string,
  synthesis: unknown,
): Record<string, unknown> {
  if (!ledger.repo)
    throw new FlowError(
      "review finalization requires a repository-bound ledger",
    );
  return ledger.activeUpdate((current) => {
    const review = isRecord(current.review) ? current.review : {};
    const waves = isRecord(review.waves) ? review.waves : {};
    const wave = isRecord(waves[waveId]) ? waves[waveId] : undefined;
    if (
      !wave ||
      typeof wave.head_sha !== "string" ||
      typeof wave.base_sha !== "string"
    )
      throw new FlowError(`review wave does not exist: ${waveId}`);
    const [lockedHead] = requireCleanCurrentHead(ledger.repo!, wave.head_sha);
    const baseRef =
      typeof wave.base_ref === "string" ? wave.base_ref : undefined;
    if (!baseRef || !gitIsMovingRef(ledger.repo!, baseRef))
      throw new FlowError(
        "review wave base ref is unavailable; refresh and retry",
      );
    const lockedBase = gitCommit(ledger.repo!, baseRef);
    if (lockedHead !== wave.head_sha || lockedBase !== wave.base_sha)
      throw new FlowError(
        "review finalization inputs changed; refresh and retry",
      );
    if (typeof review.pr_ref === "string") {
      const live = readLivePullRequest(ledger.repo!, review.pr_ref);
      if (
        live.facts.state !== "OPEN" ||
        live.facts.head_sha !== lockedHead ||
        live.facts.base_sha !== lockedBase
      )
        throw new FlowError(
          "review finalization live PR facts changed; refresh and retry",
        );
    }
    return finalizeReviewWaveState(current, waveId, synthesis, ledger.repo);
  });
}

export function authorizeRepair(
  ledger: FlowLedger,
  waveId: string,
): Record<string, unknown> {
  if (!ledger.repo)
    throw new FlowError(
      "repair authorization requires a repository-bound ledger",
    );
  return ledger.activeUpdate((current) => {
    const review = isRecord(current.review) ? current.review : {};
    const waves = isRecord(review.waves) ? review.waves : {};
    const wave = isRecord(waves[waveId]) ? waves[waveId] : undefined;
    if (
      !wave ||
      typeof wave.head_sha !== "string" ||
      typeof wave.base_sha !== "string"
    )
      throw new FlowError(`review wave does not exist: ${waveId}`);
    const [head] = requireCleanCurrentHead(ledger.repo!);
    const baseRef =
      typeof wave.base_ref === "string" ? wave.base_ref : undefined;
    if (!baseRef || !gitIsMovingRef(ledger.repo!, baseRef))
      throw new FlowError(
        "review wave base ref is unavailable; refresh and retry",
      );
    const base = gitCommit(ledger.repo!, baseRef);
    if (head !== wave.head_sha || base !== wave.base_sha)
      throw new FlowError(
        "repair authorization inputs changed; refresh and retry",
      );
    if (typeof review.pr_ref === "string") {
      const live = readLivePullRequest(ledger.repo!, review.pr_ref);
      if (
        live.facts.state !== "OPEN" ||
        live.facts.head_sha !== head ||
        live.facts.base_sha !== base
      )
        throw new FlowError(
          "repair authorization live PR facts changed; refresh and retry",
        );
    }
    return authorizeRepairState(current, waveId);
  });
}
