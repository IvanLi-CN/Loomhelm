import { describe, expect, test } from "bun:test";
import { initialLedger } from "../../modules/flow/state";
import {
  authorizeReviewRound,
  openReviewWaveState,
} from "../../modules/flow/review-wave-open";
import { finalizeReviewWaveState } from "../../modules/flow/review-wave-finalize";
import { recordSubagentReviewState } from "../../modules/flow/review-record";
import { reviewFindingFingerprint } from "../../modules/flow/review-result";
import { MAX_REVIEW_ROUNDS, sha256Bytes } from "../../modules/flow/common";

const sha = "a".repeat(40);
const lanes = [
  { lane: "comprehensive", model: "gpt-6-luna", effort: "max" },
];

function ledger(runId = "round-budget") {
  const l = initialLedger(runId, "fast-track", sha, sha, null);
  l.review_assessment = {
    tier: 3,
    reason: "round budget coverage",
    assessed_at: "2026-11-21T00:00:00.000Z",
    assessed_head_sha: sha,
    source: "agent-assessment",
  };
  return l;
}

function authorization(suffix: string) {
  const reason = `Owner approved extra review round ${suffix}.`;
  return {
    authorizationRef: `owner:${suffix}`,
    authorizationTextSha256: sha256Bytes(new TextEncoder().encode(reason)),
    reason,
    userMessageId: `msg-${suffix}`,
  };
}

/** Open a wave, record a non-clearing receipt, and finalize with a blocker. */
const blockingFinding = {
  title: "Blocking defect",
  body: "The change leaves the budget uncounted.",
  priority: 1,
  confidence_score: 0.9,
  code_location: {
    absolute_file_path: "/abs/file.ts",
    line_range: { start: 1, end: 1 },
  },
};
const blockingFingerprint = reviewFindingFingerprint(blockingFinding);

function runNonClearingRound(l: Record<string, unknown>) {
  const opened = openReviewWaveState(l, {
    stage: "initial",
    baseSha: sha,
    headSha: sha,
    laneSpecs: lanes,
  });
  const waveId = String((opened.wave as Record<string, unknown>).wave_id);
  recordSubagentReviewState(l, {
    reviewProfile: "pr-convergence",
    baseRef: sha,
    reviewAttemptId: `attempt-${waveId}`,
    reviewResultJson: JSON.stringify({
      findings: [blockingFinding],
      overall_correctness: "patch is incorrect",
      overall_explanation: "Reviewed the candidate diff and found a defect.",
      overall_confidence_score: 0.9,
    }),
    waveId,
    lane: "comprehensive",
  });
  finalizeReviewWaveState(l, waveId, {
    groups: [
      {
        group_id: "budget",
        finding_fingerprints: [blockingFingerprint],
        blocker: true,
        invariant: "review round budget is counted",
      },
    ],
    invariants: ["review round budget is counted"],
    coverage: ["comprehensive"],
    conflicts: [],
    acceptance: [],
  });
  return waveId;
}

describe("review round budget", () => {
  test("finalizing a non-clearing round increments the count", () => {
    const l = ledger();
    runNonClearingRound(l);
    const cumulative = l.review.cumulative as Record<string, unknown>;
    expect(cumulative.review_rounds).toBe(1);
  });

  test("the count survives epoch recreation", () => {
    const l = ledger();
    runNonClearingRound(l);
    // A base change retires nothing; the next round opens a new epoch.
    l.review.active_wave_id = null;
    l.review.active_epoch_id = null;
    runNonClearingRound(l);
    expect(l.review.epochs).toHaveLength(2);
    expect((l.review.cumulative as Record<string, unknown>).review_rounds).toBe(
      2,
    );
  });

  test("refuses another round once the budget is spent", () => {
    const l = ledger();
    for (let i = 0; i < MAX_REVIEW_ROUNDS; i++) {
      l.review.active_wave_id = null;
      l.review.active_epoch_id = null;
      runNonClearingRound(l);
    }
    l.review.active_wave_id = null;
    l.review.active_epoch_id = null;
    expect(() =>
      openReviewWaveState(l, {
        stage: "initial",
        baseSha: sha,
        headSha: sha,
        laneSpecs: lanes,
      }),
    ).toThrow("review round budget is exhausted");
  });

  test("a malformed authorization object is rejected", () => {
    const l = ledger();
    for (let i = 0; i < MAX_REVIEW_ROUNDS; i++) countOnce(l);
    const auth = authorization("bad");

    // A non-owner reference is rejected by the owner-ref check.
    expect(() =>
      authorizeReviewRound(l, { ...auth, authorizationRef: "user:someone" }),
    ).toThrow("owner ref");
    // A digest that does not match the reason text is rejected.
    expect(() =>
      authorizeReviewRound(l, {
        ...auth,
        authorizationTextSha256: "f".repeat(64),
      }),
    ).toThrow("matching reason digest");
    // A missing user message id is rejected.
    expect(() =>
      authorizeReviewRound(l, { ...auth, userMessageId: "  " }),
    ).toThrow("owner ref");
    // Nothing was consumed by the rejected attempts.
    const cumulative = l.review.cumulative as Record<string, unknown>;
    expect(cumulative.review_rounds_paid_ahead ?? 0).toBe(0);
    expect(cumulative.review_rounds_authorization_ids ?? []).toEqual([]);
  });

  test("an authorization message id is single-use", () => {
    const l = ledger();
    const auth = authorization("one");
    for (let i = 0; i < MAX_REVIEW_ROUNDS; i++) countOnce(l);
    // One authorization pays for the round that opens now; no balance remains.
    l.review.active_wave_id = null;
    l.review.active_epoch_id = null;
    openReviewWaveState(l, {
      stage: "initial",
      baseSha: sha,
      headSha: sha,
      laneSpecs: lanes,
      ownerReviewRoundAuthorization: auth,
    });
    const cumulative = l.review.cumulative as Record<string, unknown>;
    expect(cumulative.review_rounds_paid_ahead ?? 0).toBe(0);
    expect(cumulative.review_rounds_owner_authorized).toBe(1);

    // The message id cannot be replayed.
    l.review.active_wave_id = null;
    l.review.active_epoch_id = null;
    expect(() =>
      openReviewWaveState(l, {
        stage: "initial",
        baseSha: sha,
        headSha: sha,
        laneSpecs: lanes,
        ownerReviewRoundAuthorization: auth,
      }),
    ).toThrow("already consumed");
  });

  test("one authorization admits exactly one open", () => {
    const l = ledger();
    for (let i = 0; i < MAX_REVIEW_ROUNDS; i++) countOnce(l);
    l.review.active_wave_id = null;
    l.review.active_epoch_id = null;
    openReviewWaveState(l, {
      stage: "initial",
      baseSha: sha,
      headSha: sha,
      laneSpecs: lanes,
      ownerReviewRoundAuthorization: authorization("once"),
    });
    // A second open with no fresh authorization is refused.
    l.review.active_wave_id = null;
    l.review.active_epoch_id = null;
    expect(() =>
      openReviewWaveState(l, {
        stage: "initial",
        baseSha: sha,
        headSha: sha,
        laneSpecs: lanes,
      }),
    ).toThrow("review round budget is exhausted");
  });

  test("a credit-paid blocker wave is not charged twice", () => {
    const l = ledger();
    for (let i = 0; i < MAX_REVIEW_ROUNDS; i++) countOnce(l);
    l.review.active_wave_id = null;
    l.review.active_epoch_id = null;
    openReviewWaveState(l, {
      stage: "initial",
      baseSha: sha,
      headSha: sha,
      laneSpecs: lanes,
      ownerReviewRoundAuthorization: authorization("double-charge"),
    });
    const cumulative = l.review.cumulative as Record<string, unknown>;
    const before = cumulative.review_rounds;
    const waveId = String((l.review.active_wave_id as string) ?? "");
    const wave = (l.review.waves as Record<string, Record<string, unknown>>)[
      waveId
    ];
    // The open gate marks the round as already paid for.
    expect(wave?.review_round_paid_by_credit).toBe(true);

    recordSubagentReviewState(l, {
      reviewProfile: "pr-convergence",
      baseRef: sha,
      reviewAttemptId: "double-charge",
      reviewResultJson: JSON.stringify({
        findings: [blockingFinding],
        overall_correctness: "patch is incorrect",
        overall_explanation: "Reviewed the candidate diff and found a defect.",
        overall_confidence_score: 0.9,
      }),
      waveId,
      lane: "comprehensive",
    });
    finalizeReviewWaveState(l, waveId, {
      groups: [
        {
          group_id: "budget",
          finding_fingerprints: [blockingFingerprint],
          blocker: true,
          invariant: "review round budget is counted",
        },
      ],
      invariants: ["review round budget is counted"],
      coverage: ["comprehensive"],
      conflicts: [],
      acceptance: [],
    });
    // A credit-paid round was charged at open, so finalize must not add another.
    expect(cumulative.review_rounds).toBe(before);
  });

  test("a mismatched reason digest is rejected", () => {
    const l = ledger();
    for (let i = 0; i < MAX_REVIEW_ROUNDS; i++) countOnce(l);
    expect(() =>
      authorizeReviewRound(l, {
        ...authorization("two"),
        authorizationTextSha256: "0".repeat(64),
      }),
    ).toThrow("matching reason digest");
  });

});

/** Spend one round directly, for cases that only need the counter moved. */
function countOnce(l: Record<string, unknown>) {
  const cumulative = l.review.cumulative as Record<string, unknown>;
  cumulative.review_rounds = Number(cumulative.review_rounds ?? 0) + 1;
}
