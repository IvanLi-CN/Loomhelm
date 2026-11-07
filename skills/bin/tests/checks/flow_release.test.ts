import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeHistoricalReplay,
  parseJsonArguments,
} from "../../modules/checks";

const codes = (path: string): string[] => [
  ...new Set(
    analyzeHistoricalReplay(path, "flow").findings.map((item) => item.code),
  ),
];

const message = (role: string, text: string): Record<string, unknown> => ({
  type: "response_item",
  payload: {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  },
});

const lockedContinue = (): Record<string, unknown>[] => [
  message("user", "flow_type: fast-track"),
  message(
    "assistant",
    "<proposed_plan>\n## Flow Decision\n- flow_type: fast-track\n- lock_status: locked\n</proposed_plan>",
  ),
  message("user", "继续 [$flow-continue]"),
];

const call = (callId: string, command: string): Record<string, unknown> => ({
  type: "response_item",
  payload: {
    type: "function_call",
    name: "exec_command",
    call_id: callId,
    arguments: JSON.stringify({ cmd: command }),
  },
});

const routeCard = (
  callId: string | undefined,
  repositoryFacts: string,
): Record<string, unknown> => ({
  type: "response_item",
  payload: {
    type: "function_call_output",
    ...(callId ? { call_id: callId } : {}),
    output: {
      pre_merge_release_route: "managed",
      route_source: "project-policy",
      target_repo: "IvanLi-CN/dot-codex",
      target_pr: 210,
      current_repository_facts: repositoryFacts,
      current_pr_facts: "PR #210 head=abc123 base=main",
      managed_release_labels: ["managed-release"],
    },
  },
});

const mergedFact = (
  callId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "response_item",
  payload: {
    type: "function_call_output",
    call_id: callId,
    output: {
      state: "MERGED",
      mergedAt: "2026-10-30T00:00:00Z",
      number: 210,
      repository: "IvanLi-CN/dot-codex",
      ...extra,
    },
  },
});

describe("flow release route parity", () => {
  test("rejects duplicate JSON argument keys like the Python oracle", () => {
    expect(parseJsonArguments('{"cmd":"first","cmd":"second"}')).toEqual({});
    expect(
      parseJsonArguments('{"nested":{"cmd":"first","cmd":"second"}}'),
    ).toEqual({});
    expect(parseJsonArguments('{"nested":[{"key":1,"key":2}]}')).toEqual({});
    expect(parseJsonArguments('{"cmd":"first","label":"cmd"}')).toEqual({
      cmd: "first",
      label: "cmd",
    });
  });

  test("accepts a trusted route refresh after continue", () => {
    const temporary = mkdtempSync(join(tmpdir(), "checks-release-route-"));
    try {
      const replayPath = join(temporary, "flow.jsonl");
      const records = lockedContinue();
      records.unshift(
        call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
      );
      records.push(
        routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
      );
      writeFileSync(
        replayPath,
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      expect(analyzeHistoricalReplay(replayPath, "flow").findings).toEqual([]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("accepts JSON repository identity and target-bound merged facts", () => {
    const temporary = mkdtempSync(join(tmpdir(), "checks-release-target-"));
    try {
      const replayPath = join(temporary, "flow.jsonl");
      const records: Record<string, unknown>[] = [
        call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
        routeCard("route-card", '{"repo":"IvanLi-CN/dot-codex","base":"main"}'),
        call("merge-facts", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "merge-facts",
            output: {
              state: "MERGED",
              mergedAt: "2026-10-30T00:00:00Z",
              number: 210,
              repository: "IvanLi-CN/dot-codex",
            },
          },
        },
        ...lockedContinue(),
      ];
      writeFileSync(
        replayPath,
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      expect(codes(replayPath)).toEqual([]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("accepts fresh merged proof after a later route refresh", () => {
    const temporary = mkdtempSync(join(tmpdir(), "checks-release-refresh-"));
    try {
      const replayPath = join(temporary, "flow.jsonl");
      const records: Record<string, unknown>[] = [
        message("user", "flow_type: fast-track"),
        message(
          "assistant",
          "<proposed_plan>\n## Flow Decision\n- flow_type: fast-track\n- lock_status: locked\n</proposed_plan>",
        ),
        message("user", "继续 [$flow-continue]"),
        call("route-1", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
        routeCard("route-1", "repo=IvanLi-CN/dot-codex base=main"),
        call("merge-1", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
        mergedFact("merge-1"),
        message("user", "继续 [$flow-continue]"),
        call("route-2", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
        routeCard("route-2", "repo=IvanLi-CN/dot-codex base=main"),
        call("merge-2", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
        mergedFact("merge-2"),
        message("user", "继续 [$flow-continue]"),
      ];
      writeFileSync(
        replayPath,
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      expect(codes(replayPath)).toEqual([]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("accepts a pending route output after continue", () => {
    const temporary = mkdtempSync(join(tmpdir(), "checks-release-pending-"));
    try {
      const replayPath = join(temporary, "flow.jsonl");
      const records: Record<string, unknown>[] = [
        message("user", "flow_type: fast-track"),
        message(
          "assistant",
          "<proposed_plan>\n## Flow Decision\n- flow_type: fast-track\n- lock_status: locked\n</proposed_plan>",
        ),
        call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
        routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
        message("user", "继续 [$flow-continue]"),
        call("pending-route", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
        routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
        routeCard("pending-route", "repo=IvanLi-CN/dot-codex base=main"),
      ];
      writeFileSync(
        replayPath,
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      expect(codes(replayPath)).toEqual([]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("rejects unbound and stale release evidence", () => {
    const temporary = mkdtempSync(join(tmpdir(), "checks-release-boundary-"));
    const expected = "RELEASE_ROUTE_NOT_RERESOLVED_ON_CONTINUE";
    const scenarios: Array<[string, Record<string, unknown>[]]> = [
      [
        "unbound",
        [...lockedContinue(), routeCard(undefined, "repo=IvanLi-CN/dot-codex")],
      ],
      [
        "mismatched-repository",
        [
          ...lockedContinue(),
          call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          routeCard("route-card", "repo=evil/repo base=main"),
        ],
      ],
      [
        "mismatched-command-target",
        [
          ...lockedContinue(),
          call("route-card", "gh pr view 999 --repo evil/repo"),
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
        ],
      ],
      [
        "partial-command-target",
        [
          ...lockedContinue(),
          call("route-card", "gh pr view --repo IvanLi-CN/dot-codex"),
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
        ],
      ],
      [
        "numeric-option-operand-command-target",
        [
          ...lockedContinue(),
          call(
            "route-card",
            "gh pr view 210 --repo IvanLi-CN/dot-codex --json number --jq 210 -q 210 -t 210 -q --repo=evil/repo",
          ),
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
        ],
      ],
      [
        "repository-unbound-command-target",
        [
          ...lockedContinue(),
          call("route-card", "gh pr view 210"),
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
        ],
      ],
      [
        "unbound-merged-fact",
        [
          ...lockedContinue(),
          call("merge-facts", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          mergedFact("merge-facts"),
        ],
      ],
      [
        "non-gh-command-target",
        [
          ...lockedContinue(),
          call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
          call(
            "merge-facts",
            "python3 skills/bin/code_hosting.py --repo-root /repo --remote origin pr-merge --number 999 --method squash --expected-head deadbeef",
          ),
          mergedFact("merge-facts"),
          message("user", "继续 [$flow-continue]"),
        ],
      ],
      [
        "json-mismatched-repository",
        [
          ...lockedContinue(),
          call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          routeCard("route-card", '{"repo":"evil/repo","base":"main"}'),
        ],
      ],
      [
        "ambiguous-json-repository",
        [
          ...lockedContinue(),
          call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          routeCard(
            "route-card",
            '{"repo":"IvanLi-CN/dot-codex","repository":"evil/repo"}',
          ),
        ],
      ],
      [
        "json-textual-alias-conflict",
        [
          ...lockedContinue(),
          call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          routeCard(
            "route-card",
            '{"note":" repo=IvanLi-CN/dot-codex","repo":"evil/repo"}',
          ),
        ],
      ],
      [
        "duplicate-json-repository",
        [
          ...lockedContinue(),
          call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          routeCard(
            "route-card",
            '{"repo":"IvanLi-CN/dot-codex","repo":"evil/repo"}',
          ),
        ],
      ],
      [
        "missing-repository-identity",
        [
          ...lockedContinue(),
          call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          routeCard("route-card", "base=main"),
        ],
      ],
      [
        "spoofed-route-command",
        [
          ...lockedContinue(),
          call(
            "route-card",
            "printf 'gh pr view 210 --repo IvanLi-CN/dot-codex'",
          ),
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
        ],
      ],
      [
        "unterminated-route-command",
        [
          ...lockedContinue(),
          call(
            "route-card",
            "gh pr view 210 --repo IvanLi-CN/dot-codex 'unterminated",
          ),
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
        ],
      ],
      [
        "dangling-backslash-route-command",
        [
          ...lockedContinue(),
          call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex\\"),
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
        ],
      ],
      [
        "malformed-api-method-route-command",
        [
          ...lockedContinue(),
          call("route-card", "gh api repos/IvanLi-CN/dot-codex/pulls/210 -X"),
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
        ],
      ],
      [
        "api-option-operand-command-target",
        [
          ...lockedContinue(),
          call("route-card", "gh api --jq /repos/evil/repo/pulls/210"),
          routeCard("route-card", "repo=evil/repo base=main"),
        ],
      ],
      [
        "api-trailing-option-arity",
        [
          ...lockedContinue(),
          call("route-card", "gh api repos/IvanLi-CN/dot-codex/pulls/210 --jq"),
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
        ],
      ],
      [
        "global-pr-create",
        [
          ...lockedContinue(),
          call(
            "create-pr",
            "gh -R evil/repo pr create --base main --head topic",
          ),
          call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          {
            ...routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
            payload: {
              type: "function_call_output",
              call_id: "route-card",
              output: {
                pre_merge_release_route: "no-managed-route",
                route_source: "none",
                target_repo: "IvanLi-CN/dot-codex",
                target_pr: null,
                target_head: "abc123",
                target_base: "main",
                current_repository_facts: "repo=IvanLi-CN/dot-codex",
                current_pr_facts: "no open PR; head=abc123; base=main",
                managed_release_labels: [],
              },
            },
          },
        ],
      ],
      [
        "nested-merged-fact",
        [
          ...lockedContinue(),
          call("artifact", "echo unrelated artifact"),
          {
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "artifact",
              output: { artifact: { mergedAt: "2026-10-30T00:00:00Z" } },
            },
          },
        ],
      ],
      [
        "ambiguous-merged-target",
        [
          call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
          call("merge-facts", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          mergedFact("merge-facts", { target_pr: 999 }),
          ...lockedContinue(),
        ],
      ],
      [
        "duplicate-json-merged-fact",
        [
          call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
          call("merge-facts", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          {
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "merge-facts",
              output:
                '{"state":"MERGED","mergedAt":"2026-10-30T00:00:00Z","number":210,"number":999,"repository":"IvanLi-CN/dot-codex"}',
            },
          },
          ...lockedContinue(),
        ],
      ],
      [
        "unrelated-merged-target",
        [
          ...lockedContinue(),
          call("merge-facts", "gh -R evil/repo pr view 999"),
          {
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "merge-facts",
              output: {
                state: "MERGED",
                mergedAt: "2026-10-30T00:00:00Z",
                number: 999,
                repository: "evil/repo",
              },
            },
          },
        ],
      ],
      [
        "stale-merged-fact-after-route-refresh",
        [
          call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
          call("merge-facts", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          {
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "merge-facts",
              output: {
                state: "MERGED",
                mergedAt: "2026-10-30T00:00:00Z",
                number: 210,
                repository: "IvanLi-CN/dot-codex",
              },
            },
          },
          call("route-refresh", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          ...lockedContinue(),
        ],
      ],
      [
        "stale-merged-fact-after-pr-create",
        [
          call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
          call("merge-facts", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          {
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "merge-facts",
              output: {
                state: "MERGED",
                mergedAt: "2026-10-30T00:00:00Z",
                number: 210,
                repository: "IvanLi-CN/dot-codex",
              },
            },
          },
          call("create-pr", "gh pr create --base main --head topic"),
          ...lockedContinue(),
        ],
      ],
      [
        "stale-output-refresh-call-id",
        [
          call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
          call("new-route", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          {
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "route-card",
              output: "pre_merge_release_route: managed",
            },
          },
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
          ...lockedContinue(),
        ],
      ],
      [
        "stale-output-after-continue",
        [
          message("user", "flow_type: fast-track"),
          message(
            "assistant",
            "<proposed_plan>\n## Flow Decision\n- flow_type: fast-track\n- lock_status: locked\n</proposed_plan>",
          ),
          call("route-card", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
          message("user", "继续 [$flow-continue]"),
          routeCard("route-card", "repo=IvanLi-CN/dot-codex base=main"),
        ],
      ],
      [
        "reused-call-id-after-refresh",
        [
          message("user", "flow_type: fast-track"),
          message(
            "assistant",
            "<proposed_plan>\n## Flow Decision\n- flow_type: fast-track\n- lock_status: locked\n</proposed_plan>",
          ),
          call("same-id", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          routeCard("same-id", "repo=IvanLi-CN/dot-codex base=main"),
          message("user", "继续 [$flow-continue]"),
          call("same-id", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
          routeCard("same-id", "repo=IvanLi-CN/dot-codex base=main"),
          message("user", "继续 [$flow-continue]"),
        ],
      ],
    ];
    try {
      for (const [name, records] of scenarios) {
        const replayPath = join(temporary, `${name}.jsonl`);
        writeFileSync(
          replayPath,
          records.map((record) => JSON.stringify(record)).join("\n") + "\n",
        );
        expect(codes(replayPath)).toContain(expected);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
