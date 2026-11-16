import { describe, expect, test } from "bun:test";
import { apply, type Request } from "../lib/engine";
import { type Ledger, type Task, validateLedger } from "../lib/schema";
import {
  at,
  base,
  head,
  merge,
  groupActor,
  main,
  fixture,
  request,
  approve,
  v2Fixture,
} from "./engine-fixtures";

test("parent follow-up merge reconciles a group after its original parent PR already merged", () => {
  const ledger = fixture();
  const originalParentPr = {
    provider: "github",
    repository: "example/repo",
    id: "139",
    url: "https://github.com/example/repo/pull/139",
  };
  const followUpPr = {
    provider: "github",
    repository: "example/repo",
    id: "146",
    url: "https://github.com/example/repo/pull/146",
  };
  ledger.groups[0].parent_pr = originalParentPr;
  for (const task of ledger.tasks) task.state = "integrated";
  approve(ledger);
  const mainBase = "d".repeat(40);
  const followUpHead = "e".repeat(40);
  const followUpMerge = "f".repeat(40);
  apply(
    ledger,
    "merge-claim",
    request(
      ledger,
      "claim-parent-followup",
      {
        operation_id: "merge-parent-followup",
        group_id: "g",
        mode: "parent-followup",
        original_parent_pr: originalParentPr,
        original_parent_merge_sha: "c".repeat(40),
        target_branch: "main",
        expected_base_sha: mainBase,
        expected_head_sha: followUpHead,
        pr: followUpPr,
      },
      groupActor,
    ),
  );
  apply(
    ledger,
    "merge-resolve",
    request(
      ledger,
      "resolve-parent-followup",
      {
        operation_id: "merge-parent-followup",
        outcome: "succeeded",
        provider_evidence: {
          id: "parent-followup-merged",
          kind: "pr_merged",
          subject_id: "g",
          status: "passed",
          source: "github",
          observed_at: at,
          sha: followUpMerge,
          evidence_ref: "https://api.github.com/repos/example/repo/pulls/146",
        },
        provider_observation: {
          pr: followUpPr,
          head_sha: followUpHead,
          base_sha: mainBase,
          merge_sha: followUpMerge,
          state: "merged",
        },
      },
      groupActor,
    ),
  );
  expect(ledger.groups[0].state).toBe("merged");
  expect(ledger.groups[0].merge_sha).toBe(followUpMerge);
  expect(ledger.groups[0].current_sha).toBe(followUpMerge);
  expect(ledger.groups[0].parent_pr).toEqual(originalParentPr);
});


