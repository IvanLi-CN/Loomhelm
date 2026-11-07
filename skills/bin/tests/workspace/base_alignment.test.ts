import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planAlignment,
  type AlignmentFacts,
} from "../../modules/workspace/base_alignment";
import { applyAuto } from "../../modules/workspace/base_alignment_actions";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

function facts(overrides: Partial<AlignmentFacts> = {}): AlignmentFacts {
  return {
    repo_root: "/repo",
    base_branch: "main",
    base_remote_ref: "origin/main",
    base_remote_name: "origin",
    base_remote_branch: "main",
    head_branch: "th/example",
    primary_worktree: "/repo",
    primary_branch: "main",
    primary_clean: true,
    worktrees: [
      { path: "/repo", branch: "main", detached: false },
      { path: "/repo/.wt/pr", branch: "th/example", detached: false },
    ],
    base_holders: ["/repo"],
    linked_base_holders: [],
    local_base_exists: true,
    remote_base_exists: true,
    local_base_sha: "1111111",
    remote_base_sha: "2222222",
    base_relation: "behind_ff_only",
    fetch_error: "",
    ...overrides,
  };
}

test("base alignment blocks a linked worktree owner", () => {
  const result = planAlignment(
    facts({
      primary_branch: "th/example",
      base_holders: ["/repo/.wt/main"],
      linked_base_holders: ["/repo/.wt/main"],
    }),
  );
  expect(result.state).toBe("blocked");
  expect(result.recommended_action).toBe("blocked_linked_worktree_owns_base");
});

test("base alignment distinguishes safe fast-forward routes", () => {
  expect(planAlignment(facts()).recommended_action).toBe("pull_ff_only");
  expect(
    planAlignment(facts({ primary_branch: "release/2026q3", base_holders: [] }))
      .recommended_action,
  ).toBe("update_local_ref_ff_only");
  expect(
    planAlignment(
      facts({
        primary_branch: "th/example",
        base_holders: [],
        base_relation: "behind_ff_only",
      }),
    ).recommended_action,
  ).toBe("switch_then_pull_ff_only");
});

test("base alignment requires owner decisions for dirty or divergent bases", () => {
  expect(
    planAlignment(facts({ primary_clean: false, base_relation: "equal" }))
      .recommended_action,
  ).toBe("owner_decision_safe_align");
  expect(
    planAlignment(
      facts({
        primary_branch: "release/2026q3",
        base_holders: [],
        base_relation: "diverged",
      }),
    ).recommended_action,
  ).toBe("owner_decision_safe_align_later");
});

test("apply-auto fast-forwards a clean primary base", () => {
  const root = mkdtempSync(join(tmpdir(), "base-alignment-"));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "fixture@example.invalid");
    git(root, "config", "user.name", "fixture");
    writeFileSync(join(root, "fixture.txt"), "initial\n");
    git(root, "add", "fixture.txt");
    git(root, "commit", "-qm", "initial");
    git(root, "branch", "remote-target");
    git(root, "switch", "remote-target");
    git(root, "commit", "--allow-empty", "-qm", "remote");
    const remoteSha = git(root, "rev-parse", "HEAD");
    git(root, "update-ref", "refs/remotes/origin/main", remoteSha);
    git(root, "switch", "main");

    const [payload, exitCode] = applyAuto({
      repoRoot: root,
      baseBranch: "main",
      baseRemoteRef: "origin/main",
      headBranch: "th/example",
      refreshRemote: false,
    });

    expect(exitCode).toBe(0);
    expect(payload.applied_action).toBe("pull_ff_only");
    expect(payload.base_relation).toBe("equal");
    expect(git(root, "rev-parse", "refs/heads/main")).toBe(remoteSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
