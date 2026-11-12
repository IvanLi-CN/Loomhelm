import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analyzePrReplay } from "../../bin/modules/checks";

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

test("requires a post-merge primary-base outcome", () => {
  const mergeRecords: Record<string, unknown>[] = [
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "route-none",
        output: {
          pre_merge_release_route: "no-managed-route",
          route_source: "none",
          target_repo: "example/repo",
          target_pr: 42,
          current_repository_facts: "no release policy or managed release labels",
          current_pr_facts: "PR #42; head=abc1234; base=main",
          managed_release_labels: [],
        },
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "merge" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "headRefName=topic" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd:
            "bun skills/bin/code_hosting.ts --repo-root /repo --remote origin pr-merge --number 42 --method merge --expected-base " +
            "a".repeat(40) +
            " --expected-head " +
            "b".repeat(40),
          workdir: "/repo",
        }),
        call_id: "merge",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "merge",
        output: "✓ Merged pull request #42",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "git push origin --delete topic",
          workdir: "/repo",
        }),
        call_id: "delete",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "delete",
        output: " - [deleted]         topic",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "legacy-release-contract",
        output: {
          release_expected: false,
          release_epoch: "merge-abc1234",
          target_repo: "example/repo",
          target_branch: "main",
          target_sha: "abc1234",
          reason:
            "release_expected=false; release workflow skipped for this merge SHA",
        },
      },
    },
  ];
  const missingPath = writeReplay([
    ...mergeRecords,
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "missing-base-outcome",
        last_agent_message:
          "PR 已合并；远端分支=不存在；发布状态=未触发；依据=legacy fixture 无仓库发布面；发布版本=none；发布tag=none；发布channel=none；发布绑定sha=none；发布workflow=none；发布URL=none；发布时间=none；发布产物=none；发布处置=report-only。",
      },
    },
  ]);
  const alignedPath = writeReplay([
    ...mergeRecords,
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "bun skills/project-engineering-workflow/scripts/base_alignment_helper.ts apply-auto --repo-root /repo --base-branch main --base-remote-ref origin/main --head-branch topic --refresh-remote",
          workdir: "/repo",
        }),
        call_id: "base-align",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "base-align",
        output: JSON.stringify({
          state: "aligned",
          merge_scope_status: "已更新",
        }),
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "aligned-base-outcome",
        last_agent_message:
          "PR 已合并；远端分支=不存在；发布状态=未触发；依据=legacy fixture 无仓库发布面；发布版本=none；发布tag=none；发布channel=none；发布绑定sha=none；发布workflow=none；发布URL=none；发布时间=none；发布产物=none；发布处置=report-only。",
      },
    },
  ]);
  try {
    expect(
      analyzePrReplay(missingPath).findings.map((item) => item.code),
    ).toContain("BASE_UPDATE_RESULT_MISSING");
    expect(analyzePrReplay(alignedPath).findings).toEqual([]);
  } finally {
    cleanup(missingPath);
    cleanup(alignedPath);
  }
});
