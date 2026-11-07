import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  analyzeHistoricalReplay,
  analyzePrReplay,
  decisionFrom,
  validateReleaseDecisionCard,
} from "../../modules/checks";

const root = resolve(import.meta.dir, "../../..");

function writeReplay(records: Record<string, unknown>[]): string {
  const directory = mkdtempSync(join(tmpdir(), "checks-pr-policy-"));
  const path = join(directory, "replay.jsonl");
  writeFileSync(
    path,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  return path;
}

function cleanup(path: string): void {
  rmSync(resolve(path, ".."), { recursive: true, force: true });
}

const profile = {
  model: "gpt-6-luna",
  thinking: "max",
  source: "allowlist",
  task_class: "simple",
};

describe("PR replay policy contracts", () => {
  test("checks the normalized post-merge handoff fixtures", () => {
    const positive = resolve(
      root,
      "docs/vendor/dot-codex/specs/fast-track-merge-intent-closeout/replay/positive-parallel-release-handoff.jsonl",
    );
    const negative = resolve(
      root,
      "docs/vendor/dot-codex/specs/fast-track-merge-intent-closeout/replay/negative-serialized-release-handoff.jsonl",
    );
    expect(analyzeHistoricalReplay(positive).findings).toEqual([]);
    expect(
      analyzeHistoricalReplay(negative).findings.map((item) => item.code),
    ).toContain("HANDOFF_PREPARATION_SERIALIZED");
  });

  test("requires resolved preparation and trigger fields for release card v3", () => {
    const card = {
      publish_applicability: "yes",
      components: ["api"],
      channel: "stable",
      bump_rule: "patch",
      predicted_version: "1.2.4",
      target_repo: "example/repo",
      target_branch: "main",
      target_pr: "42",
      policy_source: "repository-contract",
      collision_policy: "block",
    };
    expect(validateReleaseDecisionCard(card)).toEqual({
      valid: true,
      reason: "",
    });
    expect(
      validateReleaseDecisionCard({
        ...card,
        contract_version: 3,
        required_preparation: "resource evidence",
        release_trigger: "manual workflow",
      }),
    ).toEqual({ valid: true, reason: "" });
    expect(
      validateReleaseDecisionCard({
        ...card,
        contract_version: 3,
        required_preparation: "unknown",
        release_trigger: "manual workflow",
      }).valid,
    ).toBe(false);
    expect(
      validateReleaseDecisionCard({ ...card, contract_version: 2 }).valid,
    ).toBe(false);
    expect(
      decisionFrom({
        decision_card: {
          ...card,
          contract_version: 3,
          required_preparation: "resource evidence",
          release_trigger: "manual workflow",
        },
      }),
    ).toMatchObject({ seen: true, valid: true });
  });

  test("invalidates an earlier owner confirmation when the card changes", () => {
    const card = {
      publish_applicability: "yes",
      components: ["api"],
      channel: "stable",
      bump_rule: "patch",
      predicted_version: "1.2.4",
      target_repo: "example/repo",
      target_branch: "main",
      target_pr: "42",
      policy_source: "repository-contract",
      collision_policy: "block",
    };
    const path = writeReplay([
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "decision-card",
          output: { decision_card: card },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "确认版本预期=1.2.4，继续合并" },
          ],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "decision-card-2",
          output: {
            decision_card: { ...card, predicted_version: "1.2.5" },
          },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          output: "✓ Merged pull request #42",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "changed-card",
          last_agent_message: "PR 已合并",
        },
      },
    ]);
    try {
      expect(analyzePrReplay(path).findings.map((item) => item.code)).toContain(
        "RELEASE_DECISION_CONFIRMATION_MISSING",
      );
    } finally {
      cleanup(path);
    }
  });
});
