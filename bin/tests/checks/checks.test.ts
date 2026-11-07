import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  analyzeActiveLongTask,
  analyzeBrowserReplay,
  analyzeHistoricalReplay,
  analyzeReleaseTracking,
  analyzeReviewProof,
  analyzeVisualReplay,
  checkInstructionArchitecture,
  checkSkillsIndex,
  checkSpec,
  eventText,
  instructionText,
  score,
  runReplayCases,
} from "../../modules/checks";

const root = resolve(import.meta.dir, "../../..");
const fixture = (relative: string): string => join(root, relative.startsWith("docs/") && !relative.startsWith("docs/vendor/") ? "docs/vendor/dot-codex/" + relative.slice(5) : relative);
const codes = (value: { findings: Array<{ code: string }> }): string[] =>
  [...new Set(value.findings.map((item) => item.code))].sort();

describe("policy and replay check migration", () => {
  test("active-long, browser, and release replay cases preserve verdicts", () => {
    expect(
      runReplayCases(
        fixture(
          "docs/vendor/dot-codex/specs/active-long-task-ownership-wait-guard/replay/cases.txt",
        ),
        analyzeActiveLongTask,
      ),
    ).toEqual([]);
    expect(
      runReplayCases(
        fixture("docs/vendor/dot-codex/specs/gn7xq-gui-escalation-gate/replay/cases.txt"),
        analyzeBrowserReplay,
      ),
    ).toEqual([]);
    expect(
      runReplayCases(
        fixture("docs/vendor/dot-codex/specs/release-tracking/replay/cases.txt"),
        analyzeReleaseTracking,
        "exact",
      ),
    ).toEqual([]);
  });

  test("historical domain adapters cover the canonical case tables", () => {
    for (const path of [
      "docs/specs/active-long-task-ownership-wait-guard/replay/cases.txt",
      "docs/specs/fast-track-merge-intent-closeout/replay/cases.txt",
      "docs/specs/gn7xq-gui-escalation-gate/replay/cases.txt",
      "docs/specs/pr-conflict-auto-heal/replay/cases.txt",
      "docs/specs/pr-skill-diagnosis-thinning/replay/cases.txt",
      "docs/specs/release-tracking/replay/cases.txt",
      "docs/specs/shared-ui-visual-evidence-gate/replay/cases.txt",
    ]) {
      const expectation = path.includes("release-tracking")
        ? "exact"
        : "required";
      expect(
        runReplayCases(fixture(path), analyzeHistoricalReplay, expectation),
      ).toEqual([]);
    }
  });

  test("review proof retains the diagnostic codes emitted by the Python oracle", () => {
    const path = fixture(
      "docs/vendor/dot-codex/specs/review-proof-dedupe-wait-guard/replay/negative-exec-session-wait-misuse.jsonl",
    );
    expect(codes(analyzeReviewProof(path))).toEqual([
      "EXEC_SESSION_WAIT_MISUSE",
      "NON_DIRECT_REVIEW_LAUNCH",
    ]);
    expect(
      codes(
        analyzeReviewProof(
          fixture(
            "docs/vendor/dot-codex/specs/review-proof-dedupe-wait-guard/replay/positive-single-proof-polling.jsonl",
          ),
        ),
      ),
    ).toEqual([]);
  });

  test("replay text extraction ignores JSON object keys", () => {
    expect(
      eventText({
        type: "event_msg",
        payload: { review: "clean", status: "ok" },
      }),
    ).toBe("clean\nok");
  });

  test("review proof dedupe keeps waves and lanes independent", () => {
    const temporary = mkdtempSync(join(tmpdir(), "checks-review-"));
    try {
      const replayPath = join(temporary, "review.jsonl");
      const launch = (callId: string, wave: string, lane: string) => ({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: `python3 bin/flow_receipt.py --repo . record --kind review --wave-id ${wave} --lane ${lane} --base-ref abc123 --head-sha def456 --review-profile merge-proof --review-effort low`,
            workdir: "/tmp/demo",
          }),
          call_id: callId,
        },
      });
      const output = (callId: string, sessionId: number) => ({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: callId,
          output: `Process running with session ID ${sessionId}`,
        },
      });
      writeFileSync(
        replayPath,
        [
          launch("launch-1", "wave-a", "contract"),
          output("launch-1", 101),
          launch("launch-2", "wave-a", "state-concurrency"),
          output("launch-2", 102),
          launch("launch-3", "wave-b", "contract"),
          output("launch-3", 103),
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );
      expect(codes(analyzeReviewProof(replayPath))).toEqual([]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("active proof intent does not bind an unrelated exec session", () => {
    const temporary = mkdtempSync(join(tmpdir(), "checks-terminal-"));
    try {
      const replayPath = join(temporary, "terminal.jsonl");
      const records = [
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "active review proof 42 还在跑；latest head=abcdef1",
              },
            ],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "sleep 30",
              workdir: "/tmp/demo",
            }),
            call_id: "call_unrelated",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_unrelated",
            output: "Process running with session ID 42",
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "unrelated-proof-session",
            last_agent_message: "PR 已合并；本地收尾=未执行。",
          },
        },
      ];
      writeFileSync(
        replayPath,
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      expect(codes(analyzeHistoricalReplay(replayPath))).not.toContain(
        "ACTIVE_GATE_CLOSED_OUT_EARLY",
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("active proof termination requires its originating write_stdin call", () => {
    const temporary = mkdtempSync(join(tmpdir(), "checks-terminal-"));
    try {
      const replayPath = join(temporary, "terminal.jsonl");
      const records = [
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "codex review --base origin/main",
              workdir: "/tmp/demo",
            }),
            call_id: "call_review",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_review",
            output: "codex review Process running with session ID 123",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "active review proof 123 还在跑；latest head=abcdef1",
              },
            ],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "echo unrelated",
              session_id: 123,
            }),
            call_id: "call_spoof",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_spoof",
            output: "Process exited with code 0",
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "review-termination-spoof",
            last_agent_message: "PR 已合并；本地收尾=未执行。",
          },
        },
      ];
      writeFileSync(
        replayPath,
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      expect(codes(analyzeHistoricalReplay(replayPath))).toContain(
        "ACTIVE_GATE_CLOSED_OUT_EARLY",
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("changed task completion messages are not treated as duplicates", () => {
    const temporary = mkdtempSync(join(tmpdir(), "checks-terminal-"));
    try {
      const replayPath = join(temporary, "terminal.jsonl");
      const records = [
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "codex review --base origin/main",
              workdir: "/tmp/demo",
            }),
            call_id: "call_review",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_review",
            output: "codex review Process running with session ID 123",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "active review proof 123 还在跑；latest head=abcdef1",
              },
            ],
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "authoritative-task-completion",
            last_agent_message: "继续 relay/poll。",
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "authoritative-task-completion",
            last_agent_message: "PR 已合并；本地收尾=未执行。",
          },
        },
      ];
      writeFileSync(
        replayPath,
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      expect(codes(analyzeHistoricalReplay(replayPath))).toContain(
        "ACTIVE_GATE_CLOSED_OUT_EARLY",
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("failed replay cases accept additional diagnostics like the Python oracle", () => {
    const temporary = mkdtempSync(join(tmpdir(), "checks-replay-"));
    try {
      const casesPath = join(temporary, "cases.txt");
      const replayPath = join(temporary, "case.jsonl");
      writeFileSync(casesPath, "fail case.jsonl EXPECTED\n");
      writeFileSync(
        replayPath,
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "EXPECTED EXTRA" }],
          },
        }),
      );
      expect(
        runReplayCases(casesPath, () => ({
          findings: [
            { code: "EXPECTED", line: 1, message: "expected" },
            { code: "EXTRA", line: 1, message: "extra" },
          ],
        })),
      ).toEqual([]);
      expect(
        runReplayCases(
          casesPath,
          () => ({
            findings: [
              { code: "EXPECTED", line: 1, message: "expected" },
              { code: "EXTRA", line: 1, message: "extra" },
            ],
          }),
          "exact",
        ),
      ).toHaveLength(1);
      expect(
        runReplayCases(
          casesPath,
          () => ({
            findings: [
              { code: "EXPECTED", line: 1, message: "first" },
              { code: "EXPECTED", line: 2, message: "duplicate" },
            ],
          }),
          "exact",
        ),
      ).toHaveLength(1);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("historical flow replay guards lock drift and Python route parity", () => {
    expect(
      codes(
        analyzeHistoricalReplay(
          fixture(
            "docs/vendor/dot-codex/specs/flow-continue-lock-guard/replay/negative-locked-fast-track-drift-to-local-merge.jsonl",
          ),
        ),
      ),
    ).toContain("LOCKED_FLOW_DRIFT_TO_LOCAL_MERGE");
    expect(
      codes(
        analyzeHistoricalReplay(
          fixture(
            "docs/vendor/dot-codex/specs/flow-continue-lock-guard/replay/negative-invalidated-permit-base-advance-routed.jsonl",
          ),
        ),
      ),
    ).toContain("REPAIR_PERMIT_BASE_ADVANCE_INVALID_ROUTE");
    expect(
      codes(
        analyzeHistoricalReplay(
          fixture(
            "docs/vendor/dot-codex/specs/flow-continue-lock-guard/replay/positive-issued-permit-base-fast-forward-opens-repair-wave.jsonl",
          ),
        ),
      ),
    ).toContain("RELEASE_ROUTE_NOT_RERESOLVED_ON_CONTINUE");
  });

  test("historical PR replay keeps merge and diagnosis guards", () => {
    expect(
      codes(
        analyzeHistoricalReplay(
          fixture(
            "docs/vendor/dot-codex/specs/fast-track-merge-intent-closeout/replay/negative-unguarded-direct-merge.jsonl",
          ),
        ),
      ),
    ).toContain("MERGE_HEAD_GUARD_MISSING");
    expect(
      codes(
        analyzeHistoricalReplay(
          fixture(
            "docs/vendor/dot-codex/specs/fast-track-merge-intent-closeout/replay/positive-guarded-direct-merge.jsonl",
          ),
        ),
      ),
    ).toEqual([]);
    expect(
      codes(
        analyzeHistoricalReplay(
          fixture(
            "docs/vendor/dot-codex/specs/pr-skill-diagnosis-thinning/replay/negative-dirty-misread-as-approval.jsonl",
          ),
        ),
      ),
    ).toContain("CONFLICT_MISDIAGNOSED_AS_APPROVAL");
  });

  test("visual replay retains owner source locks and PR confirmation gates", () => {
    expect(
      codes(
        analyzeHistoricalReplay(
          fixture(
            "docs/vendor/dot-codex/specs/shared-ui-visual-evidence-gate/replay/negative-owner-locked-web-demo-replaced-by-storybook.jsonl",
          ),
        ),
      ),
    ).toContain("LOCKED_NON_STORYBOOK_SOURCE_REPLACED_BY_STORYBOOK");
    expect(
      codes(
        analyzeHistoricalReplay(
          fixture(
            "docs/vendor/dot-codex/specs/shared-ui-visual-evidence-gate/replay/positive-component-storybook-allowed.jsonl",
          ),
        ),
      ),
    ).toEqual([]);
    expect(
      codes(
        analyzeHistoricalReplay(
          fixture(
            "docs/vendor/dot-codex/specs/shared-ui-visual-evidence-gate/replay/negative-local-pr-before-owner-confirmation.jsonl",
          ),
        ),
      ),
    ).toContain("UI_PR_CONVERGENCE_BEFORE_VISUAL_RESPONSE");
  });

  test("visual replay ignores Storybook tool-call arguments as routes", () => {
    const findings = analyzeVisualReplay(
      fixture(
        "docs/vendor/dot-codex/specs/shared-ui-visual-evidence-gate/replay/negative-full-page-storybook-before-ui-demo-check.jsonl",
      ),
    ).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("FULL_PAGE_STORYBOOK_BEFORE_UI_DEMO_CHECK");
    expect(findings[0]?.line).toBe(4);
  });

  test("visual replay ignores a first-event Storybook route", () => {
    const temporary = mkdtempSync(join(tmpdir(), "checks-visual-first-"));
    try {
      const path = join(temporary, "replay.jsonl");
      writeFileSync(
        path,
        `${JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Storybook full page" }],
          },
        })}\n`,
      );
      expect(analyzeVisualReplay(path).findings).toEqual([]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

describe("static contracts and behavior adapters", () => {
  test("provider-only configuration is unavailable; migrated Skills index remains valid", () => {
    expect(checkInstructionArchitecture(root).some(item => String(item).startsWith("TRACKER_CONFIG_INVALID"))).toBe(true);
    expect(checkSkillsIndex(root)).toEqual([]);
  });

  test("compatibility-only Skills stay out of the public index", () => {
    const index = readFileSync(fixture("skills/README.md"), "utf8");
    expect(index).toContain("`multi-task-flow`");
    expect(index).not.toContain("`wave-thread-flow`");
    expect(existsSync(fixture("skills/wave-thread-flow/SKILL.md"))).toBe(false);
  });

  test("archived provider Spec cannot override the project canonical Spec boundary", () => {
    expect(
      checkSpec(fixture("docs/vendor/dot-codex/specs/gui-escalation-gate/SPEC.md"), root),
    ).toEqual([expect.objectContaining({code: "SPEC_PATH_INVALID"})]);
  });

  test("spec checker rejects task-state sections and missing traceability", () => {
    const temporary = mkdtempSync(join(tmpdir(), "checks-spec-"));
    try {
      const path = join(temporary, "docs/specs/demo/SPEC.md");
      mkdirSync(join(temporary, "docs/specs/demo"), { recursive: true });
      writeFileSync(
        path,
        [
          "# Demo",
          "",
          "## Context and Scope",
          "Context.",
          "",
          "## Requirements",
          "REQ-DEMO MUST be preserved.",
          "",
          "## Verification",
          "VER-DEMO covers: REQ-OTHER.",
          "",
          "## Acceptance Checklist",
          "- [ ] pending",
          "",
          "## Related ADRs",
          "None",
        ].join("\n"),
      );
      const found = checkSpec(path, temporary).map((item) => item.code);
      expect(found).toContain("SPEC_FORBIDDEN_SECTION");
      expect(found).toContain("SPEC_CHECKBOX_FORBIDDEN");
      expect(found).toContain("SPEC_TRACEABILITY_MISSING");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("behavior score and instruction snapshots preserve strict fields", () => {
    expect(
      score(
        {
          route: "fast-flow",
          stop: "step-5c-ready",
          confirmation: false,
          research: false,
          visual: false,
          forbidden: ["merge"],
        },
        {
          route: "fast-flow",
          stop: "step-5c-ready",
          confirmation: false,
          research: false,
          visual: false,
          forbidden: ["merge"],
        },
      ),
    ).toEqual([]);
    expect(instructionText(root, "AGENTS.md")).toContain("Loomhelm engineering guide");
    expect(instructionText(root, "AGENTS.md", "HEAD")).toContain("Loomhelm engineering guide");
  });
});
