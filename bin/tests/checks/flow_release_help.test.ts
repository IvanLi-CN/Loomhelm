import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeHistoricalReplay } from "../../modules/checks";
import {
  commandTarget,
  isRouteResolutionCommand,
} from "../../modules/checks/flow_release_evidence";

const call = (callId: string, cmd: string): Record<string, unknown> => ({
  type: "response_item",
  payload: {
    type: "function_call",
    call_id: callId,
    name: "exec_command",
    arguments: JSON.stringify({ cmd }),
  },
});

const message = (role: string, text: string): Record<string, unknown> => ({
  type: "response_item",
  payload: {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  },
});

const routeCard = (callId: string): Record<string, unknown> => ({
  type: "response_item",
  payload: {
    type: "function_call_output",
    call_id: callId,
    output: {
      pre_merge_release_route: "managed",
      route_source: "project-policy",
      target_repo: "IvanLi-CN/dot-codex",
      target_pr: 210,
      current_repository_facts: "repo=IvanLi-CN/dot-codex base=main",
      current_pr_facts: "PR #210 head=abc123 base=main",
      managed_release_labels: ["managed-release"],
    },
  },
});

describe("flow release help command safety", () => {
  test("does not treat non-executing help flags as route proof", () => {
    for (const command of [
      "gh pr view 210 --repo IvanLi-CN/dot-codex --help",
      "gh api repos/IvanLi-CN/dot-codex/pulls/210 --help",
      "gh pr view --definitely-invalid 210 --repo IvanLi-CN/dot-codex",
      "gh api --definitely-invalid repos/IvanLi-CN/dot-codex/pulls/210",
    ]) {
      const value = call("help", command);
      expect(isRouteResolutionCommand(value)).toBe(false);
      expect(commandTarget(value)).toBeUndefined();
    }
  });

  test("retains target binding for valid inline route options", () => {
    for (const command of [
      "gh pr view 210 --repo=IvanLi-CN/dot-codex --json=number",
      "gh api --method=GET repos/IvanLi-CN/dot-codex/pulls/210",
    ]) {
      const value = call("valid", command);
      expect(isRouteResolutionCommand(value)).toBe(true);
      expect(commandTarget(value)).toEqual({
        repository: "IvanLi-CN/dot-codex",
        number: "210",
      });
    }
  });

  test("invalidates a prior route binding when help reuses its call id", () => {
    const temporary = mkdtempSync(join(tmpdir(), "checks-release-help-"));
    try {
      const records = [
        message("user", "flow_type: fast-track"),
        message(
          "assistant",
          "<proposed_plan>\n## Flow Decision\n- flow_type: fast-track\n- lock_status: locked\n</proposed_plan>",
        ),
        message("user", "继续 [$flow-continue]"),
        call("route", "gh pr view 210 --repo IvanLi-CN/dot-codex"),
        call("route", "gh pr view 999 --repo evil/repo --help"),
        routeCard("route"),
      ];
      const replayPath = join(temporary, "flow.jsonl");
      writeFileSync(
        replayPath,
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      expect(
        analyzeHistoricalReplay(replayPath, "flow").findings.map(
          (finding) => finding.code,
        ),
      ).toContain("RELEASE_ROUTE_NOT_RERESOLVED_ON_CONTINUE");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
