// Process-local mocks: real public CLI, ledger store and runtime; no native Codex side effects.
import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import * as api from "../lib/codex-agent-api";
import * as native from "../lib/codex-cli-create";

const log = (kind: string) => appendFileSync(process.env.MOCK_CODEX_LOG!, `${kind}\n`);
const originalCreate = native.createCliThread;
const base = "a".repeat(40);
mock.module("../lib/codex-agent-api", () => ({
  ...api,
  readCodexCapabilities: async () => [{ model: "gpt-6.1-sol", thinking: ["medium"] }],
}));
mock.module("../lib/codex-cli-create", () => ({
  ...native,
  verifyRepositoryIdentity: () => {},
  createCliThread: async (input: Parameters<typeof native.createCliThread>[0]) => {
    log("create");
    const threadId = `mock-${input.native_request_id}`;
    await input.onThreadStarted?.(threadId);
    if (process.env.MOCK_CODEX_UNKNOWN === "1")
      return {
        outcome: "unknown",
        thread_id: threadId,
        model: input.model,
        thinking: input.thinking,
        evidence_ref: "mock:interrupted",
        error: "mock interrupted initialization",
      };
    return originalCreate(input, {
      run: async () => ({
        thread_id: threadId,
        exit_code: 0,
        turn_completed: true,
        events: ["thread.started", "turn.completed"],
      }),
      read: async () => ({
        thread: {
          id: threadId,
          cwd: `/mock/${threadId}`,
          model: input.model,
          reasoningEffort: input.thinking,
        },
        turn: {
          id: "init-turn",
          status: "completed",
          items: [
            { type: "user_message", text: native.initializationPrompt(input.role!) },
            { type: "agent_message", text: "已进入待命状态。" },
          ],
        },
      }),
      verify: () => base,
    });
  },
  reconcileCliThread: async (input: { thread_id: string; model: string; thinking: string }) => {
    log("reconcile");
    return {
      thread_id: input.thread_id,
      model: input.model,
      thinking: input.thinking,
      workspace_path: `/mock/${input.thread_id}`,
      initial_head: base,
      turn_completed: true,
      evidence_ref: "mock:completed-init",
      created_at: new Date().toISOString(),
    };
  },
}));
await import("../scripts/orchestrate");
