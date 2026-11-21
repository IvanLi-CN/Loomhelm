import { describe, expect, test } from "bun:test";
import { initialLedger } from "../../modules/flow/state";
import {
  authorizeReviewRound,
  openReviewWaveState,
} from "../../modules/flow/review-wave-open";
import { countReviewRound } from "../../modules/flow/review-wave-finalize";
import { MAX_REVIEW_ROUNDS } from "../../modules/flow/common";

const sha = "a".repeat(40);
const lanes = [
  { lane: "comprehensive", model: "gpt-6-luna", effort: "max" },
];

function ledger() {
  const l = initialLedger("round-budget", "fast-track", sha, sha, null);
  l.review_assessment = {
    tier: 3,
    reason: "round budget coverage",
    assessed_at: "2026-11-21T00:00:00.000Z",
    assessed_head_sha: sha,
    source: "agent-assessment",
  };
  return l;
}

describe("review round budget", () => {
  test("counts every non-clearing round in cumulative, not per epoch", () => {
    const l = ledger();
    // Re-opening a wave starts a new epoch each time. The count must survive.
    for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
      l.review.active_wave_id = null;
      l.review.active_epoch_id = null;
      openReviewWaveState(l, {
        stage: "initial",
        baseSha: sha,
        headSha: sha,
        laneSpecs: lanes,
      });
      expect((l.review.cumulative as Record<string, unknown>).review_rounds).toBe(
        round - 1,
      );
      countReviewRound(l.review);
    }
    expect((l.review.cumulative as Record<string, unknown>).review_rounds).toBe(
      MAX_REVIEW_ROUNDS,
    );
    expect(l.review.epochs).toHaveLength(MAX_REVIEW_ROUNDS);
  });

  test("refuses another round once the budget is spent", () => {
    const l = ledger();
    for (let i = 0; i < MAX_REVIEW_ROUNDS; i++) countReviewRound(l.review);
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

  test("one owner authorization buys exactly one more round", () => {
    const l = ledger();
    for (let i = 0; i < MAX_REVIEW_ROUNDS; i++) countReviewRound(l.review);
    l.review.active_wave_id = null;
    l.review.active_epoch_id = null;
    expect(() =>
      openReviewWaveState(l, {
        stage: "initial",
        baseSha: sha,
        headSha: sha,
        laneSpecs: lanes,
        ownerReviewRoundAuthorization: "Owner approved one more round.",
      }),
    ).not.toThrow();
    const cumulative = l.review.cumulative as Record<string, unknown>;
    expect(cumulative.review_rounds_owner_authorized).toBe(1);

    // The extra round is spent: a second attempt needs a new authorization.
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
    expect(() => authorizeReviewRound(l, "  ")).toThrow(
      "review round budget is exhausted",
    );
  });

  test("two authorizations buy two rounds, no more", () => {
    const l = ledger();
    for (let i = 0; i < MAX_REVIEW_ROUNDS; i++) countReviewRound(l.review);
    const cumulative = l.review.cumulative as Record<string, unknown>;
    for (let i = 0; i < 2; i++) {
      l.review.active_wave_id = null;
      l.review.active_epoch_id = null;
      openReviewWaveState(l, {
        stage: "initial",
        baseSha: sha,
        headSha: sha,
        laneSpecs: lanes,
        ownerReviewRoundAuthorization: `Owner approved extra round ${i + 1}.`,
      });
      countReviewRound(l.review);
    }
    expect(cumulative.review_rounds).toBe(MAX_REVIEW_ROUNDS);
    expect(cumulative.review_rounds_owner_authorized).toBe(2);
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

  test("a clearing round never consumes the budget", () => {
    const l = ledger();
    expect(
      (l.review.cumulative as Record<string, unknown>).review_rounds,
    ).toBe(0);
    l.review.active_wave_id = null;
    l.review.active_epoch_id = null;
    expect(() =>
      openReviewWaveState(l, {
        stage: "initial",
        baseSha: sha,
        headSha: sha,
        laneSpecs: lanes,
      }),
    ).not.toThrow();
    expect(
      (l.review.cumulative as Record<string, unknown>).review_rounds,
    ).toBe(0);
  });
});
