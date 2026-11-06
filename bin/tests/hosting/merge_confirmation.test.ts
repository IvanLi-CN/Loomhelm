import { expect, test } from "bun:test";
import { mergeConfirmationMatches } from "../../modules/hosting/compatibility_cli_helpers";
import type { PullRequestFacts } from "../../modules/hosting/pull-request";

const head = "a".repeat(40);

function facts(overrides: Partial<PullRequestFacts>): PullRequestFacts {
  return {
    number: 1,
    url: "https://github.com/owner/demo/pull/1",
    state: "OPEN",
    base_sha: "a".repeat(40),
    base_ref: "main",
    base_repository: "owner/demo",
    head_sha: head,
    head_ref: "feature",
    head_repository: "owner/demo",
    ...overrides,
  };
}

test("merge confirmation accepts the provider's post-merge base SHA", () => {
  const before = facts({});
  const after = facts({
    state: "MERGED",
    base_sha: "c".repeat(40),
    merge_sha: "c".repeat(40),
  });
  expect(mergeConfirmationMatches(before, after, head)).toBe(true);
  expect(
    mergeConfirmationMatches(
      before,
      { ...after, head_sha: "b".repeat(40) },
      head,
    ),
  ).toBe(false);
});
