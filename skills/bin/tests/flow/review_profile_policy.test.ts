import { describe, expect, test } from "bun:test";
import {
  DIRECT_REVIEW_POLICY_PROFILES,
  directReviewRuntimeFields,
  selectDirectReviewProfile,
  selectDirectReviewProfiles,
} from "../../modules/flow/review-profile-policy";

describe("direct review profile policy", () => {
  test("keeps the six ordered runtime profiles", () => {
    expect(
      DIRECT_REVIEW_POLICY_PROFILES.map(
        ({ model, effort }) => `${model} + ${effort}`,
      ),
    ).toEqual([
      "gpt-6-luna + high",
      "gpt-6-luna + max",
      "gpt-5.6-luna + xhigh",
      "gpt-5.6-luna + max",
      "gpt-6.1-terra + xhigh",
      "gpt-6.1-sol + medium",
    ]);
  });

  test("selects complexity profiles without runtime capability probing", () => {
    expect(
      selectDirectReviewProfile("ordinary", { lane: "contract" }),
    ).toMatchObject({
      model: "gpt-6-luna",
      effort: "high",
      source: "allowlist",
      profile: 1,
    });
    expect(
      selectDirectReviewProfile("complex", { lane: "state-concurrency" }),
    ).toMatchObject({
      model: "gpt-5.6-luna",
      effort: "xhigh",
      profile: 3,
    });
    expect(
      selectDirectReviewProfile("rigorous", { lane: "failure-data-safety" }),
    ).toMatchObject({
      model: "gpt-5.6-luna",
      effort: "max",
      profile: 4,
    });
    expect(
      selectDirectReviewProfile("high-risk", {
        lane: "security",
        escalationReason: "安全边界存在升级风险",
      }),
    ).toMatchObject({
      model: "gpt-6.1-terra",
      effort: "xhigh",
      profile: 5,
    });
    expect(
      selectDirectReviewProfile("special", {
        lane: "test-platform",
        escalationReason: "specialized platform risk",
      }),
    ).toMatchObject({
      model: "gpt-6.1-sol",
      effort: "medium",
      profile: 6,
    });
  });

  test("requires a lane-specific reason for escalation profiles", () => {
    expect(() =>
      selectDirectReviewProfile("special", {
        lane: "contract",
        escalationReason: "the contract lane has no escalation reason",
      }),
    ).toThrow("lane-specific escalation reason");
    expect(() =>
      selectDirectReviewProfile("special", {
        lane: "contract",
        escalationReason: "合同低风险",
      }),
    ).toThrow("lane-specific escalation reason");
    expect(() =>
      selectDirectReviewProfile("special", { lane: "test-platform" }),
    ).toThrow("requires an escalation reason");
  });

  test("forwards complete owner overrides exactly", () => {
    const profile = selectDirectReviewProfile("ordinary", {
      lane: "contract",
      ownerOverride: { model: "owner-model", effort: "future-effort" },
    });
    expect(profile).toMatchObject({
      model: "owner-model",
      effort: "future-effort",
      source: "owner-override",
      override_scope: "invocation",
    });
    expect(directReviewRuntimeFields(profile)).toEqual({
      model: "owner-model",
      reasoning_effort: "future-effort",
    });
    expect(() =>
      selectDirectReviewProfile("ordinary", {
        lane: "contract",
        ownerOverride: { model: "owner-model" },
        overrideScope: "lane",
      }),
    ).toThrow("complete model and effort pair");
  });

  test("applies invocation and lane-scoped overrides", () => {
    const lanes = {
      contract: "ordinary",
      "state-concurrency": "complex",
      "failure-data-safety": "rigorous",
      "test-platform": "special",
    };
    const invocation = selectDirectReviewProfiles(lanes, {
      ownerOverride: { model: "owner-model", effort: "owner-effort" },
      escalationReasons: { "test-platform": "specialized platform risk" },
    });
    expect(
      Object.values(invocation).every(
        (item) => item.source === "owner-override",
      ),
    ).toBe(true);
    const named = selectDirectReviewProfiles(lanes, {
      ownerOverride: { model: "owner-model", effort: "owner-effort" },
      overrideLane: "state-concurrency",
      escalationReasons: { "test-platform": "specialized platform risk" },
    });
    expect(named["state-concurrency"]).toMatchObject({
      source: "owner-override",
    });
    expect(named.contract).toMatchObject({
      model: "gpt-6-luna",
      effort: "high",
    });
    expect(named["test-platform"]?.escalation_reason).toBe(
      "specialized platform risk",
    );
  });
});
